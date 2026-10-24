#pragma once
#include <Arduino.h>
#include <NimBLEDevice.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "ble_callbacks.h"

constexpr size_t BLE_MAX_PAYLOAD = 128;
constexpr size_t CLIPBOARD_MAX_BYTES = 1024;

struct ClipboardTransfer {
  uint8_t transferId;
  uint16_t len;
  uint8_t data[CLIPBOARD_MAX_BYTES];
};

// ---------------------------------------------------------------------------
// Wire format (InterDesk's custom 128-bit service): HID on characteristic
// 1235, clipboard on 1236, and clipboard results on 1237.
//
// This header is the reference for the BLE protocol shared with the Electron
// app. There is no codegen between the two sides, so any change here must be
// mirrored there. HID report lengths select their report type; clipboard
// frames use the ID marker below.
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
// Clipboard messages begin with the two-byte ID marker.
//   BEGIN: 49 44 01 transfer-id length-lo length-hi
//   CHUNK: 49 44 02 transfer-id sequence-lo sequence-hi data...
//   END:   49 44 03 transfer-id
// The result characteristic (1237) notifies:
//   49 44 81 transfer-id status skipped-count-lo skipped-count-hi
// ATT writes stay within 20 bytes for the default MTU.
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



// A versioned, application-specific 128-bit service UUID avoids collisions
// with 16-bit assigned UUIDs and gives BLE centrals a new cache identity when
// the InterDesk GATT profile changes.
static const NimBLEUUID SVC_UUID("98b5f6d3-3d7a-4f71-8ef0-1d3ed6fa2026");
static const NimBLEUUID DATA_UUID("1235");
static const NimBLEUUID CLIPBOARD_DATA_UUID("1236");
static const NimBLEUUID CLIPBOARD_STATUS_UUID("1237");

// Also the advertised name - this is the string the InterDesk app shows in its
// device list, so the two must not drift apart.
constexpr const char* SERVER_NAME = "InterDesk Dongle";


class BleServer {
public:
  BleServer(QueueHandle_t rxQueue, QueueHandle_t clipboardQueue);
  void start();            // init + start advertising

  //soft start
  void soft_stop(bool disconnectClient /* = true */);
  void resume();
  void setConnected(uint16_t connHandle) { _connected = true; _connHandle = connHandle; }
  void handleDisconnected();
  bool handleClipboardFrame(const uint8_t* data, size_t len);
  void notifyClipboardResult(uint8_t transferId, bool ok, uint16_t skippedCharacters);
  bool advEnabled() const { return _advEnabled; }

private:
  NimBLEServer* pServer = nullptr;
  NimBLEService* pService = nullptr;
  NimBLECharacteristic* pDataCharacteristic = nullptr;
  NimBLECharacteristic* pClipboardDataCharacteristic = nullptr;
  NimBLECharacteristic* pClipboardStatusCharacteristic = nullptr;

  ServerCallbacks _serverCallbacks;
  CharacteristicDataCallbacks _dataCallbacks;
  ClipboardDataCallbacks _clipboardCallbacks;

  bool _started = false;
  bool _connected = false;
  uint16_t _connHandle = 0xFFFF;
  NimBLEAdvertising* _adv = nullptr;
  bool _advEnabled = true;   // when false, onDisconnect must NOT restart advertising
  QueueHandle_t _rxQueue;
  QueueHandle_t _clipboardQueue;
  ClipboardTransfer _clipboardAssembly{};
  uint16_t _clipboardExpectedBytes = 0;
  uint16_t _clipboardReceivedBytes = 0;
  uint16_t _clipboardExpectedSequence = 0;
  uint32_t _clipboardLastFrameMs = 0;
  bool _clipboardActive = false;

};
