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

//optimization, timing tests
#include "esp_timer.h"
#include "esp_cpu.h"

#ifndef ENABLE_BUTTON_TASK
#define ENABLE_BUTTON_TASK 0
#endif

constexpr UBaseType_t BLE_QUEUE_LENGTH = 16;
constexpr uint32_t PERF_REPORT_PERIOD_MS = 5000;

static QueueHandle_t bleRxQ;
static BleServer* ble = nullptr;

static TaskHandle_t decoderTaskHandle = nullptr;
static TaskHandle_t displayTaskHandle = nullptr;
#if ENABLE_BUTTON_TASK
static TaskHandle_t buttonTaskHandle = nullptr;
#endif

bool startTasks();
void DecoderTask(void*);
void DisplayTask(void*);
#if ENABLE_BUTTON_TASK
void ButtonTask(void*);
#endif


UiState gUi; //mutexed global instance 
SemaphoreHandle_t uiMtx;
EventGroupHandle_t uiEv;
EventGroupHandle_t taskReadyEv;
enum : EventBits_t {
  UI_EV_STATE  = (1 << 0),
  UI_EV_DEBUG  = (1 << 1),
  UI_EV_ALL    = UI_EV_STATE | UI_EV_DEBUG
};
enum : EventBits_t {
  TASK_READY_DECODER = (1 << 0),
  TASK_READY_DISPLAY = (1 << 1),
#if ENABLE_BUTTON_TASK
  TASK_READY_BUTTON  = (1 << 2),
  TASK_READY_ALL = TASK_READY_DECODER | TASK_READY_DISPLAY | TASK_READY_BUTTON
#else
  TASK_READY_ALL = TASK_READY_DECODER | TASK_READY_DISPLAY
#endif
};

USBHIDKeyboard keyboard;
USBHIDMouse mouse;

bool hid_decode(const BlePacket& pkt);
static void ui_set_debug(const char* s);
static void ui_toggle_airdrop();



void setup() {
  Serial.begin(115200);
  const uint32_t serialWaitStarted = millis();
  while (!Serial && millis() - serialWaitStarted < 2000) {
    delay(10);
  }
  
  //Create BLE recieved queue
  bleRxQ = xQueueCreate(BLE_QUEUE_LENGTH, sizeof(BlePacket));
  if (bleRxQ == nullptr) {
    Serial.println("ERROR: BLE queue allocation failed");
    return;
  }

  // start BLE
  ble = new BleServer(bleRxQ);
  ble->start();

  gUi.AirDropOn = false;

  keyboard.begin();
  mouse.begin();
  // USB CDC on boot starts the composite USB device before setup().

  //start decoder task

  const uint64_t t1 = esp_timer_get_time();
  const uint32_t c1 = esp_cpu_get_cycle_count();
  const bool tasksReady = startTasks();
  const uint32_t elapsedCycles = esp_cpu_get_cycle_count() - c1;
  const uint64_t elapsedUs = esp_timer_get_time() - t1;

#ifdef PERF_BUILD_O2
  constexpr const char* optimization = "O2";
#elif defined(PERF_BUILD_OS)
  constexpr const char* optimization = "Os";
#else
  constexpr const char* optimization = "default";
#endif
  //initial serial print
  Serial.printf(
      "PERF build=%s tasks_ready=%s startup_us=%llu startup_cycles=%u "
      "queue_item_bytes=%u queue_storage_bytes=%u button_task=%s\n",
      optimization,
      tasksReady ? "yes" : "no",
      static_cast<unsigned long long>(elapsedUs),
      elapsedCycles,
      static_cast<unsigned>(sizeof(BlePacket)),
      static_cast<unsigned>(BLE_QUEUE_LENGTH * sizeof(BlePacket)),
      ENABLE_BUTTON_TASK ? "on" : "off");

}

bool startTasks() {
  uiMtx = xSemaphoreCreateMutex();
  uiEv  = xEventGroupCreate();
  taskReadyEv = xEventGroupCreate();

  if (uiMtx == nullptr || uiEv == nullptr || taskReadyEv == nullptr) {
    return false;
  }

  const BaseType_t decoderCreated = xTaskCreatePinnedToCore(
    DecoderTask,        // task function
    "decoder",          // name
    6144,               // stack bytes (start with 6 KB)
    nullptr,            // param
    18,                 // priority (higher than UI, lower than GPIO)
    &decoderTaskHandle, // handle (optional)
    1                   // core: 0 or 1
  );

  const BaseType_t displayCreated = xTaskCreatePinnedToCore(
    DisplayTask,
    "display",
    6144,     // display libs often need stack
    nullptr,
    5,        // low priority
    &displayTaskHandle,
    1         // core 1
  );

#if ENABLE_BUTTON_TASK
  const BaseType_t buttonCreated = xTaskCreatePinnedToCore(
  ButtonTask,        // task function
  "button",
  2048,              // stack (small task)
  nullptr,           // param
  8,                 // priority (below decoder, above idle)
  &buttonTaskHandle, // handle (optional)
  1                  // core 1
  );
#else
  constexpr BaseType_t buttonCreated = pdPASS;
#endif

  if (decoderCreated != pdPASS || displayCreated != pdPASS || buttonCreated != pdPASS) {
    return false;
  }

  const EventBits_t ready = xEventGroupWaitBits(
      taskReadyEv, TASK_READY_ALL, pdFALSE, pdTRUE, pdMS_TO_TICKS(5000));
  return (ready & TASK_READY_ALL) == TASK_READY_ALL;
}


void DecoderTask(void*) {
  BlePacket pkt;
  uint32_t lastReportMs = millis();
  uint32_t processed = 0;
  uint32_t invalid = 0;
  uint64_t totalQueueLatencyUs = 0;
  uint32_t maxQueueLatencyUs = 0;
  uint64_t totalDecodeUs = 0;
  uint32_t maxDecodeUs = 0;
  uint64_t totalDecodeCycles = 0;
  uint32_t maxDecodeCycles = 0;

  xEventGroupSetBits(taskReadyEv, TASK_READY_DECODER);

  for (;;) {
    if (xQueueReceive(bleRxQ, &pkt, pdMS_TO_TICKS(250)) == pdTRUE) {
      const uint32_t decodeStartedUs = static_cast<uint32_t>(esp_timer_get_time());
      const uint32_t queueLatencyUs = decodeStartedUs - pkt.receivedUs;
      const uint32_t decodeStartedCycles = esp_cpu_get_cycle_count();
      const bool valid = hid_decode(pkt);
      const uint32_t decodeCycles =
          esp_cpu_get_cycle_count() - decodeStartedCycles;
      const uint32_t decodeUs =
          static_cast<uint32_t>(esp_timer_get_time()) - decodeStartedUs;

      ++processed;
      totalQueueLatencyUs += queueLatencyUs;
      totalDecodeUs += decodeUs;
      totalDecodeCycles += decodeCycles;
      maxQueueLatencyUs = max(maxQueueLatencyUs, queueLatencyUs);
      maxDecodeUs = max(maxDecodeUs, decodeUs);
      maxDecodeCycles = max(maxDecodeCycles, decodeCycles);

      if (!valid) {
        ++invalid;
        ui_set_debug("HID BAD");
      }
    }

    const uint32_t nowMs = millis();
    if (nowMs - lastReportMs >= PERF_REPORT_PERIOD_MS) {
      lastReportMs = nowMs;
      const BleRxStats rx = ble->rxStats();
      const uint32_t avgQueueLatencyUs = processed
          ? static_cast<uint32_t>(totalQueueLatencyUs / processed) : 0;
      const uint32_t avgDecodeUs = processed
          ? static_cast<uint32_t>(totalDecodeUs / processed) : 0;
      const uint32_t avgDecodeCycles = processed
          ? static_cast<uint32_t>(totalDecodeCycles / processed) : 0;
      const uint32_t dropPpm = rx.received
          ? static_cast<uint32_t>((static_cast<uint64_t>(rx.dropped) * 1000000ULL) /
                                  rx.received)
          : 0;

      Serial.printf(
          "PERF rx=%u queued=%u dropped=%u drop_ppm=%u depth_max=%u "
          "processed=%u invalid=%u queue_us_avg=%u queue_us_max=%u "
          "decode_us_avg=%u decode_us_max=%u decode_cycles_avg=%u "
          "decode_cycles_max=%u stack_hwm=%u heap_free=%u heap_min=%u\n",
          rx.received, rx.queued, rx.dropped, dropPpm, rx.maxQueueDepth,
          processed, invalid, avgQueueLatencyUs, maxQueueLatencyUs,
          avgDecodeUs, maxDecodeUs, avgDecodeCycles, maxDecodeCycles,
          static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
          ESP.getFreeHeap(), ESP.getMinFreeHeap());
    }

  }
}

//DisplayTask and modes
void DisplayTask(void* arg) {
  Display disp;
  disp.display_init();
  xEventGroupSetBits(taskReadyEv, TASK_READY_DISPLAY);

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

#if ENABLE_BUTTON_TASK
void ButtonTask(void*) {
  pinMode(PIN_BTN1, INPUT_PULLUP);
  xEventGroupSetBits(taskReadyEv, TASK_READY_BUTTON);

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
#endif

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
    static uint8_t last_buttons = 0;
    uint8_t buttons = pkt.data[0];
    int8_t dx = static_cast<int8_t>(pkt.data[1]);
    int8_t dy = static_cast<int8_t>(pkt.data[2]);
    int8_t wheel = static_cast<int8_t>(pkt.data[3]);

    uint8_t pressed = buttons & ~last_buttons;
    uint8_t released = ~buttons & last_buttons;
    if (pressed) mouse.press(pressed);
    if (released) mouse.release(released);
    last_buttons = buttons;

    if (dx != 0 || dy != 0 || wheel != 0) {
      mouse.move(dx, dy, wheel);
    }
    return true;
  }

  return false;
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
