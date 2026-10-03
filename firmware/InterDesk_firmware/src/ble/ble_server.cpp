#include "ble_server.h"
#include <esp_system.h>

#ifdef ARDUINO
static_assert(MYNEWT_VAL(BLE_SM_LEGACY) == 0 && MYNEWT_VAL(BLE_SM_SC) == 1,
              "InterDesk requires Secure Connections without legacy pairing");
#endif

BleServer::BleServer(QueueHandle_t rxQueue)
    : _rxQueue(rxQueue), _serverCallbacks(*this), _dataCallbacks(*this), _controlCallbacks(*this) {}

void BleServer::start() {
    NimBLEDevice::init(SERVER_NAME);
    NimBLEDevice::setSecurityAuth(true, true, true); // Bonding, MITM; SC-only is enforced by the PlatformIO build.
    NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
    // Use the callback, never NimBLE's default static passkey.
    NimBLEDevice::setSecurityPasskey(123456 /* NimBLE callback sentinel */);
    _server = NimBLEDevice::createServer();
    _server->setCallbacks(&_serverCallbacks, false);
    auto* service = _server->createService(SVC_UUID);
    auto* data = service->createCharacteristic(DATA_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_ENC | NIMBLE_PROPERTY::WRITE_AUTHEN, BLE_MAX_PAYLOAD);
    data->setCallbacks(&_dataCallbacks);
    auto* control = service->createCharacteristic(CONTROL_UUID,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::READ_AUTHEN |
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_ENC | NIMBLE_PROPERTY::WRITE_AUTHEN, 1);
    control->setCallbacks(&_controlCallbacks);
    _server->start();
    auto* advertising = NimBLEDevice::getAdvertising();
    advertising->setName(SERVER_NAME);
    advertising->addServiceUUID(SVC_UUID);
    advertising->enableScanResponse(true);
    advertising->start();
    Serial.println("Hold button 2s to pair; 8s to forget all trusted laptops.");
}

bool BleServer::pairingOpen() const {
    return _pairingOpen.load() && millis() - _pairingStartedAt.load() < PAIRING_WINDOW_MS;
}

void BleServer::openPairingWindow(bool eraseBonds) {
    // The physical button is the only way to enrol a laptop, even on first boot.
    // Disconnect first, so opening/replacing trust always clears remote input.
    failLink();
    if (eraseBonds) NimBLEDevice::deleteAllBonds();
    _passkey = esp_random() % 1000000;
    _pairingStartedAt = millis();
    _pairingOpen = true;
#ifndef HAS_TFT
    Serial.printf("Pairing code: %06lu (valid 60 seconds)\n", static_cast<unsigned long>(_passkey.load()));
#endif
    if (_connHandle.load() == BLE_HS_CONN_HANDLE_NONE) NimBLEDevice::startAdvertising();
}

bool BleServer::handleConnected(NimBLEConnInfo& info) {
    _connHandle = info.getConnHandle();
    _authorized = false;
    _closing = false;
    _pairingRequested = false;
    _connectedAt = millis();
    _knownPeer = NimBLEDevice::isBonded(info.getIdAddress());
    resetInput();
    if (!_knownPeer && !pairingOpen()) {
        _server->disconnect(info.getConnHandle());
        return false;
    }
    return true; // The protected CONTROL read triggers OS security negotiation.
}

uint32_t BleServer::displayPasskey() {
    _pairingRequested = true;
    if (!pairingOpen()) {
        // A peer with lost keys must not silently replace an existing bond.
        // NimBLE may already have removed that bond on a repeat-pairing request;
        // this gate still prevents accepting its replacement without the button.
        failLink();
        return esp_random() % 1000000;
    }
    return _passkey.load();
}

void BleServer::handleAuthenticated(NimBLEConnInfo& info) {
    if (info.getConnHandle() != _connHandle.load()) return;
    if (_closing.load() || !info.isEncrypted() || !info.isAuthenticated() || info.getSecKeySize() != 16 ||
        ((!_knownPeer || _pairingRequested) && !pairingOpen())) {
        failLink();
        return;
    }
    _lastPacketAt = millis();
    _authorized = true;
    _pairingOpen = false;
    _passkey = 0;
}

bool BleServer::canAcceptInput(const NimBLEConnInfo& info) const {
    return _authorized.load() && info.getConnHandle() == _connHandle.load() &&
        info.isEncrypted() && info.isAuthenticated() && info.getSecKeySize() == 16;
}

void BleServer::resetInput() {
    const uint32_t generation = ++_generation;
    xQueueReset(_rxQueue);
    BlePacket reset{};
    reset.type = BlePacketType::Reset;
    reset.generation = generation;
    reset.receivedAt = millis();
    xQueueSend(_rxQueue, &reset, 0);
}

void BleServer::receive(const uint8_t* data, size_t len, bool control) {
    if (!_authorized.load() || _closing.load()) return;
    if (control) {
        if (len != 1 || data[0] > 1) return;
        _lastPacketAt = millis();
        if (data[0] == 0) resetInput();
        return;
    }
    if (len != 4 && len != 6 && len != 8) return;
    if (len == 8 && data[1] != 0) return;
    _lastPacketAt = millis();
    BlePacket packet{};
    packet.type = BlePacketType::HidReport;
    packet.len = len;
    packet.receivedAt = millis();
    packet.generation = _generation.load();
    memcpy(packet.data, data, len);
    // Dropping an arbitrary release could leave a key held forever. Clear the
    // entire session instead of replaying a partially lost input sequence.
    if (xQueueSend(_rxQueue, &packet, 0) != pdTRUE) failLink();
}

void BleServer::failLink() {
    _authorized = false;
    if (_closing.exchange(true)) return;
    resetInput();
    const auto handle = _connHandle.load();
    if (_server && handle != BLE_HS_CONN_HANDLE_NONE) _server->disconnect(handle);
}

void BleServer::handleDisconnected(uint16_t handle) {
    if (handle != _connHandle.load()) return;
    _connHandle = BLE_HS_CONN_HANDLE_NONE;
    _authorized = false;
    _closing = false;
    resetInput();
    NimBLEDevice::startAdvertising();
}

void BleServer::poll() {
    if (_pairingOpen.load() && !pairingOpen()) {
        _pairingOpen = false;
        _passkey = 0;
    }
    if (_connHandle.load() == BLE_HS_CONN_HANDLE_NONE || _closing.load()) return;
    // The host callback may update a timestamp between these loads. Signed
    // differences tolerate that tiny future timestamp as well as millis wrap.
    if ((_authorized.load() && static_cast<int32_t>(millis() - _lastPacketAt.load()) > static_cast<int32_t>(LINK_IDLE_TIMEOUT_MS)) ||
        (!_authorized.load() && static_cast<int32_t>(millis() - _connectedAt.load()) > static_cast<int32_t>(PAIRING_WINDOW_MS))) {
        failLink();
    }
}
