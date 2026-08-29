#pragma once
#include <Arduino.h>
#include <NimBLEDevice.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "ble_callbacks.h"

constexpr size_t BLE_MAX_PAYLOAD = 128;

// ---------------------------------------------------------------------------
// Wire format (DATA characteristic 1235, service B00B).
//
// This header is the reference for the BLE protocol shared with the Electron
// app. There is no codegen between the two sides, so any change here must be
// mirrored there. The payload length alone selects the report type; decoding
// happens in hid_decode() in main.cpp.
//
// 8 bytes -> USB HID boot keyboard report
//   [0]    modifier bitmask
//   [1]    reserved (0)
//   [2..7] up to six HID usage codes of currently pressed keys
//
// 4 bytes -> relative mouse report
//   [0] buttons bitmask (bit0 left, bit1 right, bit2 middle)
//   [1] dx    (int8)
//   [2] dy    (int8)
//   [3] wheel (int8)
//
// 6 bytes -> absolute mouse report
//   [0]    buttons bitmask (bit0 left, bit1 right, bit2 middle)
//   [1..2] x, uint16 little-endian, 0..32767
//   [3..4] y, uint16 little-endian, 0..32767
//   [5]    wheel (int8, still relative)
//   X/Y live in a virtual 0..32767 coordinate space that the host maps onto the
//   whole screen. Both mouse modes stay enabled at once; relative is the
//   fallback/gaming path.
//
// Any other length is rejected.
// ---------------------------------------------------------------------------

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
