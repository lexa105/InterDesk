#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "ble/ble_server.h"

#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "display.h"

#define PIN_BTN1 0

#include "USB.h"
#include "USBHIDMouse.h"
#include "USBHIDKeyboard.h"
#include "usb/abs_mouse.h"

static QueueHandle_t bleRxQ;
static BleServer* ble = nullptr;

static TaskHandle_t decoderTaskHandle = nullptr;
static TaskHandle_t displayTaskHandle = nullptr;
static TaskHandle_t buttonTaskHandle = nullptr;

void startTasks();
void DecoderTask(void*);
void DisplayTask(void*);
void ButtonTask(void*);


UiState gUi; //mutexed global instance 
SemaphoreHandle_t uiMtx;
EventGroupHandle_t uiEv;
enum : EventBits_t {
  UI_EV_STATE  = (1 << 0),
  UI_EV_DEBUG  = (1 << 1),
  UI_EV_ALL    = UI_EV_STATE | UI_EV_DEBUG
};

USBHIDKeyboard keyboard;
USBHIDMouse mouse;
USBHIDAbsMouse absMouse;

bool hid_decode(const BlePacket& pkt);
static void hid_release_all();
static void ui_set_debug(const char* s);
static void ui_toggle_airdrop();

static uint8_t hidMouseButtons = 0;


void setup() {
  Serial.begin(115200);
  
  //Create BLE recieved queue
  bleRxQ = xQueueCreate(16, sizeof(BlePacket));

  // start BLE
  ble = new BleServer(bleRxQ);
  ble->start();

  gUi.AirDropOn = false;

  keyboard.begin();
  mouse.begin();
  absMouse.begin();
  USB.begin();

  //start decoder task
  startTasks();
    
}

void startTasks() {
  uiMtx = xSemaphoreCreateMutex();
  uiEv  = xEventGroupCreate();

  xTaskCreatePinnedToCore(
    DecoderTask,        // task function
    "decoder",          // name
    6144,               // stack bytes (start with 6 KB)
    nullptr,            // param
    18,                 // priority (higher than UI, lower than GPIO)
    &decoderTaskHandle, // handle (optional)
    1                   // core: 0 or 1
  );

  xTaskCreatePinnedToCore(
    DisplayTask,
    "display",
    6144,     // display libs often need stack
    nullptr,
    5,        // low priority
    &displayTaskHandle,
    1         // core 1
  );

  xTaskCreatePinnedToCore(
  ButtonTask,        // task function
  "button",
  2048,              // stack (small task)
  nullptr,           // param
  8,                 // priority (below decoder, above idle)
  &buttonTaskHandle, // handle (optional)
  1                  // core 1
  );
}


void DecoderTask(void*) {
  BlePacket pkt;
  static uint32_t last = 0;
  for (;;) {
    if (xQueueReceive(bleRxQ, &pkt, portMAX_DELAY) == pdTRUE) {
      if (pkt.type == BlePacketType::Disconnected) {
        hid_release_all();
      } else if (!hid_decode(pkt)) {
        ui_set_debug("HID BAD");
      }
    }

    //
    if (millis() - last > 5000) {
      last = millis();
      Serial.printf("Decoder stack HW=%u\n", uxTaskGetStackHighWaterMark(nullptr));
    }

  }
}

//DisplayTask and modes
void DisplayTask(void* arg) {
  Display disp;
  disp.display_init();

  //struct with all display data
  UiState snap;

  for (;;) {
    // Wait until something changes OR timeout for periodic refresh
    EventBits_t bits = xEventGroupWaitBits(
      uiEv,
      UI_EV_ALL,
      pdTRUE,     // clear bits on exit
      pdFALSE,    // wait for any bit
      pdMS_TO_TICKS(1000) // periodic refresh every 1s (set to portMAX_DELAY to be pure event-driven)
    );

    // Snapshot state quickly
    xSemaphoreTake(uiMtx, portMAX_DELAY);
    snap = gUi;
    xSemaphoreGive(uiMtx);

    // Render only what changed (if timeout, bits==0 => you choose what to refresh)
    if (bits & UI_EV_STATE) {
        if (snap.AirDropOn) {
          disp.display_show_state("AIRDROP ON");
          ble->soft_stop(true);
        } else {
          disp.display_show_state("AIRDROP OFF");
          ble->resume();
        }
      }
    if (bits & UI_EV_DEBUG) disp.display_show_debug(snap.debug);
  }
}

void ButtonTask(void*) {
  pinMode(PIN_BTN1, INPUT_PULLUP);

  const TickType_t period = pdMS_TO_TICKS(5); //5ms to tick
  const uint32_t debounce_ms = 25;
  const uint32_t long_press = 500;

  bool lastRead = digitalRead(PIN_BTN1);
  bool stableRead   = lastRead;
  uint32_t lastChangeMs = millis();
  uint32_t lastStableLow = millis();

  for (;;) {
    vTaskDelay(period);

    bool read = digitalRead(PIN_BTN1);
    uint32_t now = millis();

    if (read != lastRead) {
      lastRead = read;
      lastChangeMs = now;
    }

    if ((now - lastChangeMs) >= debounce_ms && read != stableRead) {
      stableRead = read;

      if (stableRead == LOW) {
        lastStableLow = now;
      } else if (now - lastStableLow >= long_press) {
        ui_toggle_airdrop();
      }
    }
  }
}

void loop() {
}

bool hid_decode(const BlePacket& pkt){
  // Standard 8-byte keyboard report.
  if (pkt.len == 8) {
    keyboard.sendReport((KeyReport*)pkt.data);
    return true;
  }

  // 4-byte relative mouse report: [buttons, dx (int8), dy (int8), wheel (int8)]
  // Sent by MouseMonitor on the Electron side. Buttons bitmask matches USBHIDMouse's
  // MOUSE_LEFT/MOUSE_RIGHT/MOUSE_MIDDLE, so it can be passed straight to press()/release().
  if (pkt.len == 4) {
    uint8_t buttons = pkt.data[0] & MOUSE_ALL;
    int8_t dx = static_cast<int8_t>(pkt.data[1]);
    int8_t dy = static_cast<int8_t>(pkt.data[2]);
    int8_t wheel = static_cast<int8_t>(pkt.data[3]);

    uint8_t pressed = buttons & ~hidMouseButtons;
    uint8_t released = ~buttons & hidMouseButtons;
    if (pressed) mouse.press(pressed);
    if (released) mouse.release(released);
    hidMouseButtons = buttons;

    if (dx != 0 || dy != 0 || wheel != 0) {
      mouse.move(dx, dy, wheel);
    }
    return true;
  }

  // 6-byte absolute mouse report:
  //   [0]    buttons bitmask (bit0 left, bit1 right, bit2 middle)
  //   [1..2] x, uint16 little-endian, 0..32767
  //   [3..4] y, uint16 little-endian, 0..32767
  //   [5]    wheel (int8, relative)
  // Position is in the DeskHop-style virtual 0..32767 space; the host maps it to
  // the full screen. Clamping happens in USBHIDAbsMouse::sendReport().
  if (pkt.len == 6) {
    uint8_t buttons = pkt.data[0] & ABS_MOUSE_ALL;
    uint16_t x = static_cast<uint16_t>(pkt.data[1]) | (static_cast<uint16_t>(pkt.data[2]) << 8);
    uint16_t y = static_cast<uint16_t>(pkt.data[3]) | (static_cast<uint16_t>(pkt.data[4]) << 8);
    int8_t wheel = static_cast<int8_t>(pkt.data[5]);

    absMouse.sendReport(buttons, x, y, wheel);
    return true;
  }

  return false;
}

static void hid_release_all() {
  keyboard.releaseAll();
  mouse.release(MOUSE_ALL);
  hidMouseButtons = 0;
  absMouse.releaseAll();
  Serial.println("USB HID state cleared after BLE disconnect");
}

static void ui_set_debug(const char* s) {
  xSemaphoreTake(uiMtx, portMAX_DELAY);
  strncpy(gUi.debug, s, sizeof(gUi.debug)-1);
  gUi.debug[sizeof(gUi.debug)-1] = '\0';
  xSemaphoreGive(uiMtx);

  xEventGroupSetBits(uiEv, UI_EV_DEBUG);
}

static void ui_toggle_airdrop() {
  xSemaphoreTake(uiMtx, portMAX_DELAY);
  gUi.AirDropOn = !gUi.AirDropOn;
  xSemaphoreGive(uiMtx);

  xEventGroupSetBits(uiEv, UI_EV_STATE);
}
