#pragma once
#include <Arduino.h>
#include <NimBLEDevice.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "ble_callbacks.h"

constexpr size_t BLE_MAX_PAYLOAD = 128;

enum class BlePacketType : uint8_t {
  HidReport,
  Disconnected,
};

struct BlePacket {
  BlePacketType type;
  uint16_t len;
  uint8_t  data[BLE_MAX_PAYLOAD];
};



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
  void handleDisconnected();
  bool advEnabled() const { return _advEnabled; }

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
  QueueHandle_t _rxQueue;

};
