#include <Arduino.h>
#include "NimBLEDevice.h"
#include "ble_server.h"

BleServer::BleServer(QueueHandle_t rxQueue)
: _serverCallbacks(*this)
, _dataCallbacks(rxQueue)
, _rxQueue(rxQueue)
{}

void BleServer::handleDisconnected() {
  _connected = false;
  _connHandle = 0xFFFF;

  // Reports queued before the link went down belong to the old BLE session.
  // Drop them, then make the decoder release every USB HID control locally.
  xQueueReset(_rxQueue);
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

    pService->start();

    _adv = NimBLEDevice::getAdvertising();
    _adv->setName("BLE-Dongle");
    _adv->addServiceUUID(pService->getUUID());
    _adv->enableScanResponse(true);
    _adv->start();

    _started = true;

  Serial.printf("Advertising Started\n");
   
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
