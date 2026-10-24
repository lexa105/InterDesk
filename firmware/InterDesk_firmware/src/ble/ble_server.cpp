#include <Arduino.h>
#include "NimBLEDevice.h"
#include "ble_server.h"
#include <cstring>

BleServer::BleServer(QueueHandle_t rxQueue, QueueHandle_t clipboardQueue)
: _serverCallbacks(*this)
, _dataCallbacks(rxQueue)
, _clipboardCallbacks(*this)
, _rxQueue(rxQueue)
, _clipboardQueue(clipboardQueue)
{}

void BleServer::handleDisconnected() {
  _connected = false;
  _connHandle = 0xFFFF;

  // Reports queued before the link went down belong to the old BLE session.
  // Drop them, then make the decoder release every USB HID control locally.
  xQueueReset(_rxQueue);
  if (_clipboardQueue) xQueueReset(_clipboardQueue);
  _clipboardActive = false;
  _clipboardExpectedBytes = 0;
  _clipboardReceivedBytes = 0;
  _clipboardExpectedSequence = 0;
  _clipboardLastFrameMs = 0;
  BlePacket event{};
  event.type = BlePacketType::Disconnected;
  if (xQueueSend(_rxQueue, &event, 0) != pdTRUE) {
    Serial.println("Failed to queue HID disconnect cleanup");
  }
}

void BleServer::start() {

    NimBLEDevice::init(SERVER_NAME);
    NimBLEDevice::setMTU(185); // helps if you later use longer writes; actual depends on client
    pServer = NimBLEDevice::createServer();


    pServer->setCallbacks(&_serverCallbacks);

    pService = pServer->createService(SVC_UUID);

    pDataCharacteristic = pService->createCharacteristic(
        DATA_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    ); 
    pDataCharacteristic->setCallbacks(&_dataCallbacks);

    pClipboardDataCharacteristic = pService->createCharacteristic(
        CLIPBOARD_DATA_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    pClipboardDataCharacteristic->setCallbacks(&_clipboardCallbacks);

    pClipboardStatusCharacteristic = pService->createCharacteristic(
        CLIPBOARD_STATUS_UUID,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
    );

    pService->start();

    _adv = NimBLEDevice::getAdvertising();
    _adv->setName(SERVER_NAME);
    _adv->addServiceUUID(pService->getUUID());
    _adv->enableScanResponse(true);
    _adv->start();

    _started = true;

  Serial.printf("Advertising Started\n");
   
}

bool BleServer::handleClipboardFrame(const uint8_t* data, size_t len) {
  constexpr uint8_t MAGIC_0 = 0x49;
  constexpr uint8_t MAGIC_1 = 0x44;
  constexpr uint8_t FRAME_BEGIN = 0x01;
  constexpr uint8_t FRAME_CHUNK = 0x02;
  constexpr uint8_t FRAME_END = 0x03;

  if (len < 4 || data[0] != MAGIC_0 || data[1] != MAGIC_1) return false;

  const uint8_t command = data[2];
  const uint8_t transferId = data[3];

  if (_clipboardActive && millis() - _clipboardLastFrameMs > 5000) {
    _clipboardActive = false;
    _clipboardExpectedBytes = 0;
    _clipboardReceivedBytes = 0;
    _clipboardExpectedSequence = 0;
  }

  if (command == FRAME_BEGIN) {
    if (len != 6) return false;
    const uint16_t expected = static_cast<uint16_t>(data[4]) |
                              (static_cast<uint16_t>(data[5]) << 8);
    if (expected == 0 || expected > CLIPBOARD_MAX_BYTES || _clipboardActive) {
      _clipboardActive = false;
      notifyClipboardResult(transferId, false, 0);
      return true;
    }
    _clipboardAssembly.transferId = transferId;
    _clipboardExpectedBytes = expected;
    _clipboardReceivedBytes = 0;
    _clipboardExpectedSequence = 0;
    _clipboardLastFrameMs = millis();
    _clipboardActive = true;
    return true;
  }

  if (command == FRAME_CHUNK) {
    if (len < 7 || len > 20) return false;
    const uint16_t sequence = static_cast<uint16_t>(data[4]) |
                              (static_cast<uint16_t>(data[5]) << 8);
    const size_t chunkBytes = len - 6;
    if (!_clipboardActive || transferId != _clipboardAssembly.transferId ||
        sequence != _clipboardExpectedSequence ||
        _clipboardReceivedBytes + chunkBytes > _clipboardExpectedBytes) {
      _clipboardActive = false;
      notifyClipboardResult(transferId, false, 0);
      return true;
    }

    memcpy(_clipboardAssembly.data + _clipboardReceivedBytes, data + 6, chunkBytes);
    _clipboardReceivedBytes += static_cast<uint16_t>(chunkBytes);
    _clipboardExpectedSequence++;
    _clipboardLastFrameMs = millis();
    return true;
  }

  if (command == FRAME_END) {
    if (len != 4) return false;
    if (!_clipboardActive || transferId != _clipboardAssembly.transferId ||
        _clipboardReceivedBytes != _clipboardExpectedBytes) {
      _clipboardActive = false;
      notifyClipboardResult(transferId, false, 0);
      return true;
    }

    _clipboardAssembly.len = _clipboardReceivedBytes;
    _clipboardActive = false;
    if (!_clipboardQueue || xQueueSend(_clipboardQueue, &_clipboardAssembly, 0) != pdTRUE) {
      notifyClipboardResult(transferId, false, 0);
    }
    return true;
  }

  return false;
}

void BleServer::notifyClipboardResult(uint8_t transferId, bool ok, uint16_t skippedCharacters) {
  if (!_connected || !pClipboardStatusCharacteristic) return;
  const uint8_t result[] = {
      0x49, 0x44, 0x81, transferId, static_cast<uint8_t>(ok ? 0 : 1),
      static_cast<uint8_t>(skippedCharacters & 0xff),
      static_cast<uint8_t>((skippedCharacters >> 8) & 0xff),
  };
  pClipboardStatusCharacteristic->setValue(result, sizeof(result));
  pClipboardStatusCharacteristic->notify();
}

void BleServer::soft_stop(bool disconnectClient) {
  _advEnabled = false;
  if (!_started) return;

  NimBLEDevice::stopAdvertising();
  if (_adv) _adv->stop();

  if (disconnectClient && _connected && pServer && _connHandle != 0xFFFF) {
    pServer->disconnect(_connHandle);
  }
  
}


void BleServer::resume() {
  // Only makes sense if BLE stack was started before
  if (!_started) return;

  // If we are already connected, do not advertise
  if (_connected) return;

  _advEnabled = true;
  // Make sure we have an advertising object
  if (_adv == nullptr) {
    _adv = NimBLEDevice::getAdvertising();
    if (_adv == nullptr) return;
  }

  // Start advertising again (idempotent enough for typical NimBLE usage)
  _adv->start();
  // Alternatively:
  // NimBLEDevice::startAdvertising();
}
