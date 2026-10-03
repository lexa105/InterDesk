#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "ble/ble_server.h"
#include "display.h"
#include "USB.h"
#include "USBHIDMouse.h"
#include "USBHIDKeyboard.h"
#include "usb/abs_mouse.h"
#include "usb/pairing_code.h"

namespace {
constexpr uint8_t BUTTON_PIN = 0;
constexpr uint32_t BUTTON_DEBOUNCE_MS = 25;
constexpr uint32_t PAIR_HOLD_MS = 2000;
constexpr uint32_t FORGET_HOLD_MS = 8000;
constexpr UBaseType_t INPUT_QUEUE_LENGTH = 16;

QueueHandle_t inputQueue;
QueueHandle_t pairingCodeQueue;
BleServer* ble = nullptr;
USBHIDKeyboard keyboard;
USBHIDMouse mouse;
USBHIDAbsMouse absMouse;
USBHID hid;
// Keep USB stalls bounded too; one combined relative report per BLE packet.
constexpr uint32_t USB_REPORT_TIMEOUT_MS = 10;

struct PairingCodeOutput {
    uint32_t now() const { return millis(); }
    bool ready() const { return hid.ready(); }
    bool matches(uint32_t passkey) const {
        return ble->pairingOpen() && ble->pairingPasskey() == passkey;
    }
    bool sendKeyboard(const uint8_t (&report)[8]) const {
        return hid.SendReport(HID_REPORT_ID_KEYBOARD, report, sizeof(report), USB_REPORT_TIMEOUT_MS);
    }
    void pause(uint32_t duration) const { vTaskDelay(pdMS_TO_TICKS(duration)); }
};

bool releaseAll() {
    if (!hid.ready()) return false;
    const uint8_t keyboardReport[8] = {};
    const hid_mouse_report_t mouseReport = {};
    const bool keyboardReleased = hid.SendReport(HID_REPORT_ID_KEYBOARD, keyboardReport, sizeof(keyboardReport), USB_REPORT_TIMEOUT_MS);
    const bool mouseReleased = hid.SendReport(HID_REPORT_ID_MOUSE, &mouseReport, sizeof(mouseReport), USB_REPORT_TIMEOUT_MS);
    const bool absoluteReleased = absMouse.releaseAll();
    return keyboardReleased && mouseReleased && absoluteReleased;
}

bool decodeHid(const BlePacket& packet) {
    if (packet.len == 8) {
        return hid.SendReport(HID_REPORT_ID_KEYBOARD, packet.data, 8, USB_REPORT_TIMEOUT_MS);
    }
    if (packet.len == 4) {
        const hid_mouse_report_t report = {
            .buttons = static_cast<uint8_t>(packet.data[0] & MOUSE_ALL),
            .x = static_cast<int8_t>(packet.data[1]),
            .y = static_cast<int8_t>(packet.data[2]),
            .wheel = static_cast<int8_t>(packet.data[3]),
            .pan = 0,
        };
        return hid.SendReport(HID_REPORT_ID_MOUSE, &report, sizeof(report), USB_REPORT_TIMEOUT_MS);
    }
    if (packet.len == 6) {
        const uint16_t x = packet.data[1] | (static_cast<uint16_t>(packet.data[2]) << 8);
        const uint16_t y = packet.data[3] | (static_cast<uint16_t>(packet.data[4]) << 8);
        return absMouse.sendReport(packet.data[0], x, y, static_cast<int8_t>(packet.data[5]));
    }
    return false;
}

void decoderTask(void*) {
    uint32_t generation = ble->generation();
    bool releasePending = true;
    for (;;) {
        BlePacket packet{};
        const bool received = xQueueReceive(inputQueue, &packet, pdMS_TO_TICKS(10)) == pdTRUE;
        const auto currentGeneration = ble->generation();
        if (generation != currentGeneration) {
            releasePending = true;
            generation = currentGeneration;
        }
        if (received && packet.generation == generation && packet.type == BlePacketType::Reset) {
            releasePending = true;
        }
        PairingCodeRequest pairingCode{};
        if (xQueueReceive(pairingCodeQueue, &pairingCode, 0) == pdTRUE) {
            // Only pollButton can enqueue this command; BLE cannot request code
            // typing. Keep it separate from link resets/disconnect callbacks.
            PairingCodeOutput output;
            if (!releaseAll() || !typePairingCode(pairingCode, output)) {
                Serial.println("Code typing stopped. Focus a text editor, enable Num Lock, and hold/release the button again.");
            }
            releasePending = true;
            // A new BLE session must not inherit a report discarded here.
            if (received && packet.type == BlePacketType::HidReport) ble->failLink();
            continue;
        }
        // USB may be suspended while BLE disconnects. Retry releases on wake;
        // never forget a failed release and leave the host with a held control.
        if (releasePending) {
            releasePending = !releaseAll();
            if (releasePending) {
                if (received && packet.type == BlePacketType::HidReport) ble->failLink();
                continue;
            }
        }
        if (!received || packet.generation != generation || packet.type == BlePacketType::Reset) continue;
        if (!ble->authorized()) continue;
        if (millis() - packet.receivedAt > MAX_INPUT_AGE_MS || !decodeHid(packet)) {
            // A blocked USB host must not cause a burst of old movement/typing.
            ble->failLink();
            releasePending = true;
        }
    }
}

#ifdef HAS_TFT
void displayTask(void*) {
    Display display;
    display.display_init();
    char previous[40] = "";
    for (;;) {
        char status[40];
        if (ble->pairingOpen()) {
            snprintf(status, sizeof(status), "PAIR: %06lu", static_cast<unsigned long>(ble->pairingPasskey()));
        } else {
            snprintf(status, sizeof(status), "%s", ble->authorized() ? "CONNECTED" : "HOLD 2s TO PAIR");
        }
        if (strcmp(previous, status) != 0) {
            display.display_show_state(status);
            strcpy(previous, status);
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
#endif

void pollButton() {
    static bool lastRead = HIGH;
    static bool stableRead = HIGH;
    static uint32_t changedAt = 0;
    static uint32_t pressedAt = 0;
    const bool read = digitalRead(BUTTON_PIN);
    const uint32_t now = millis();
    if (read != lastRead) {
        lastRead = read;
        changedAt = now;
    }
    if (now - changedAt < BUTTON_DEBOUNCE_MS || read == stableRead) return;
    stableRead = read;
    if (read == LOW) pressedAt = now;
    else if (now - pressedAt >= PAIR_HOLD_MS) {
        // Act on release so an eight-second hold never briefly opens pairing
        // before the old trust records are erased.
        ble->openPairingWindow(now - pressedAt >= FORGET_HOLD_MS);
        const PairingCodeRequest code{ble->pairingPasskey(), millis()};
        xQueueOverwrite(pairingCodeQueue, &code);
    }
}
} // namespace

void setup() {
    Serial.begin(115200);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    inputQueue = xQueueCreate(INPUT_QUEUE_LENGTH, sizeof(BlePacket));
    configASSERT(inputQueue);
    pairingCodeQueue = xQueueCreate(1, sizeof(PairingCodeRequest));
    configASSERT(pairingCodeQueue);
    keyboard.begin();
    mouse.begin();
    absMouse.begin();
    USB.begin();
    ble = new BleServer(inputQueue);
    ble->start();
    const auto decoderCreated = xTaskCreatePinnedToCore(decoderTask, "input", 6144, nullptr, 18, nullptr, 1);
    configASSERT(decoderCreated == pdPASS);
#ifdef HAS_TFT
    const auto displayCreated = xTaskCreatePinnedToCore(displayTask, "display", 4096, nullptr, 5, nullptr, 1);
    configASSERT(displayCreated == pdPASS);
#endif
}

void loop() {
    ble->poll();
    pollButton();
    delay(5);
}
