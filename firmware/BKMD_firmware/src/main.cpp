#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "ble/ble_server.h"

#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "display.h"

#define PIN_BTN1 0

//nclude "utils/Logger.h"

#include "USB.h"
#include "USBHIDMouse.h"
#include "USBHIDKeyboard.h"

static QueueHandle_t bleRxQ;
static BleServer* ble = nullptr;

static TaskHandle_t decoderTaskHandle = nullptr;
static TaskHandle_t displayTaskHandle = nullptr;
static TaskHandle_t buttonTaskHandle = nullptr;

//to clean?
void startTasks();
void DecoderTask(void*);
void DisplayTask(void*);
void ButtonTask(void*);

//to learn

UiState gUi; //mutexed global instance 
SemaphoreHandle_t uiMtx;
EventGroupHandle_t uiEv;
enum : EventBits_t {
  UI_EV_STATE  = (1 << 0),
  UI_EV_TEXT   = (1 << 1),
  UI_EV_DEBUG  = (1 << 2),
  UI_EV_ALL    = UI_EV_STATE | UI_EV_TEXT | UI_EV_DEBUG
};

USBHIDKeyboard keyboard;
USBHIDMouse mouse;

//to clean - move to dedicated class/header
bool hid_decode(BlePacket pkt);
bool util_decode(BlePacket pkt);
static void ui_set_debug(const char* s);
static void ui_set_state(const char* s);
static void ui_toggle_airdrop();


void setup() {
  Serial.begin(115200);

  //loger::begin(); // creates logQ + logger task
  
  //Create BLE recieved queue
  bleRxQ = xQueueCreate(16, sizeof(BlePacket));

  // start BLE
  ble = new BleServer(bleRxQ);
  ble->start();

  gUi.AirDropOn = false;

  keyboard.begin();
  USB.begin(); // tohle nejak vypne serial1 - uart ne ? takze logger task bude na serial2

  //start decoder task
  startTasks();
    
}

//TEMPORARY SOLUTION for keyboard release
static TimerHandle_t kbReleaseTimer = nullptr;
static void kbReleaseTimerCb(TimerHandle_t) {
  keyboard.releaseAll();
}
static inline void scheduleKeyboardRelease(uint32_t delayMs);

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


  //Temporary
  kbReleaseTimer = xTimerCreate(
  "kbRel",
  pdMS_TO_TICKS(50),
  pdFALSE,        // one-shot
  nullptr,
  kbReleaseTimerCb
);

}


//Decodes BLE packet from queue. Appplies HID. Changes Display and Util data.
void DecoderTask(void*) {
  BlePacket pkt;
  static uint32_t last = 0;
  for (;;) {
    if (xQueueReceive(bleRxQ, &pkt, portMAX_DELAY) == pdTRUE) {
      // decode pkt - t_ms,len,data
      if (pkt.callback == 0) {//data characteristic 
        bool ok = hid_decode(pkt);
        
        // 2. Update UI state
        if (ok) {
          ui_set_debug("HID OK");
        } else {
          ui_set_debug("HID BAD");
        }
      } else { //else if(callback == 1)
        bool ok = util_decode(pkt);
         if (ok) {
          ui_set_debug("UTIL OK");
        } else {
          ui_set_debug("UTIL BAD"); 
        }
      }
    }

    //
    if (millis() - last > 5000) {
      last = millis();
      Serial.printf("Decoder stack HW=%u\n", uxTaskGetStackHighWaterMark(nullptr));
    }

  }
}

//DisplayTask + MODE handle
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
        //disp.display_show_state(snap.big)
        if (snap.AirDropOn) {
          disp.display_show_state("AIRDROP ON");
          ble->soft_stop(true);
        } else {
          disp.display_show_state("AIRDROP OFF");
          ble->resume();
        }
      }
    if (bits & UI_EV_TEXT)  disp.display_show_text(snap.text);
    if (bits & UI_EV_DEBUG) disp.display_show_debug(snap.debug);
    // If you want: always update a tiny status line/counters here on timeout too
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

    //button state changed now
    if (read != lastRead) {
      lastRead = read;
      lastChangeMs = now;
    }

    //one press - no matter lenght
    //make double press and long press??
    if ((now - lastChangeMs) >= debounce_ms && read != stableRead) {
      stableRead= read;

      if (stableRead == LOW) {            // pressed (pullup)
        lastStableLow = now;
        ui_set_debug("BTN PRESSED");
        //one press
        

      } else {                        // released
        if(now - lastStableLow >= long_press){
          ui_set_debug("LONG RELEASED");
          ui_toggle_airdrop();
        } else{
          ui_set_debug("SHORT RELEASED");
          keyboard.print("Tesst Clipboard vice klaves zmacknutych jak to bude lexa implemenvovat to jsem zvedavej1234{}[]!@#$"); //funguje cele
        }
      }
    }
  }
}

void loop() {
  //vTaskDelay(pdMS_TO_TICKS(1000));
}


//TO CHANGE - WAITING FOR LEXA CODE
//combine mouse nad keyboad packet? why not
//keyboard send from PC both PRESS and RELASE PACKET
bool hid_decode(BlePacket pkt){
  // 1. Check for standard 8-byte HID keyboard report
  if (pkt.len == 8) {
    // Send the raw 8-byte report directly to the PC.
    // This allows the Electron app to control both press and release states perfectly.
    keyboard.sendReport((KeyReport*)pkt.data);
    return true;
  }

  // 2. Fallback for legacy 1-byte usageID behavior
  if (pkt.len == 1) {
    uint8_t usageID = pkt.data[0];
    if (usageID != 0) {
      size_t pressed = keyboard.pressRaw(usageID);
      // Still need the auto-release for legacy 1-byte packets
      scheduleKeyboardRelease(200); 
      return (pressed >= 1);
    }
  }

  // Future: add mouse handle (pkt.len == 4 or similar)
  return false;
}

//handles more different packets
//- clipboard
//- setup
bool util_decode(BlePacket pkt){
  const char packetType = pkt.data[0];
  if(packetType == '1') {
    ui_toggle_airdrop();
    return true;
  } else if(packetType == 'C') { //CLIPBOARD PASTE
    if (pkt.len <= 1) return false;

    char text[BLE_MAX_PAYLOAD]; 
    size_t n = pkt.len - 1;

    memcpy(text, &pkt.data[1], n);
    text[n] = '\0';               // should be on end of string ?

    keyboard.print(text);
    return true;
  } else{
    return false;
  }

}


//to learn
//
static void ui_set_state(const char* s) {
  xSemaphoreTake(uiMtx, portMAX_DELAY);
  strncpy(gUi.big, s, sizeof(gUi.big)-1);
  gUi.big[sizeof(gUi.big)-1] = '\0';
  xSemaphoreGive(uiMtx);

  //wake up display task
  xEventGroupSetBits(uiEv, UI_EV_STATE);
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

//temporary
static inline void scheduleKeyboardRelease(uint32_t delayMs) {
  // restart timer so repeated calls delay the release (common desired behavior)
  xTimerStop(kbReleaseTimer, 0);
  xTimerChangePeriod(kbReleaseTimer, pdMS_TO_TICKS(delayMs), 0);
  xTimerStart(kbReleaseTimer, 0);
}

