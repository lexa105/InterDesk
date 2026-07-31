#pragma once
#include <Arduino.h>
#include <NimBLEDevice.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "ble_callbacks.h"

// The only supported payloads are a 4-byte mouse report and an 8-byte
// keyboard report. Keep the original length so oversized reports are rejected
// by the decoder, but never copy unused bytes through the FreeRTOS queue.
constexpr size_t HID_REPORT_MAX_SIZE = 8;

struct BlePacket {
  // A 32-bit microsecond timestamp wraps after about 71 minutes. Unsigned
  // subtraction in the decoder handles the wrap and keeps this struct small.
  uint32_t receivedUs;
  uint16_t len;
  uint8_t  data[HID_REPORT_MAX_SIZE];
};

static_assert(sizeof(BlePacket) == 16, "Unexpected BlePacket padding");



static const NimBLEUUID SVC_UUID("B00B");
static const NimBLEUUID DATA_UUID("1235");

constexpr const char* SERVER_NAME = "BLE Universal Dongle";


class BleServer {
public:
  explicit BleServer(QueueHandle_t rxQueue);
  void start();            // init + start advertising

  //soft start
  void soft_stop(bool disconnectClient /* = true */);
  void resume();
  void setConnected(uint16_t connHandle) { _connected = true; _connHandle = connHandle; }
  void setDisconnected() { _connected = false; _connHandle = 0xFFFF; }
  bool advEnabled() const { return _advEnabled; }
  BleRxStats rxStats() const { return _dataCallbacks.stats(); }

private:
  NimBLEServer* pServer = nullptr;
  NimBLEService* pService = nullptr;
  NimBLECharacteristic* pDataCharacteristic = nullptr;

  ServerCallbacks _serverCallbacks;
  CharacteristicDataCallbacks _dataCallbacks;

  bool _started = false;
  bool _connected = false;
  uint16_t _connHandle = 0xFFFF;
  NimBLEAdvertising* _adv = nullptr;
  bool _advEnabled = true;   // when false, onDisconnect must NOT restart advertising

};
