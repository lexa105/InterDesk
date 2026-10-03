#include "ble_callbacks.h"
#include "ble_server.h"

void ServerCallbacks::onConnect(NimBLEServer* server, NimBLEConnInfo& info) {
    if (!_owner.handleConnected(info)) return;
    // 7.5..15 ms interval, no slave latency, 2-second link supervision timeout.
    server->updateConnParams(info.getConnHandle(), 6, 12, 0, 200);
}

void ServerCallbacks::onDisconnect(NimBLEServer*, NimBLEConnInfo& info, int) {
    _owner.handleDisconnected(info.getConnHandle());
}

void ServerCallbacks::onAuthenticationComplete(NimBLEConnInfo& info) {
    _owner.handleAuthenticated(info);
}

uint32_t ServerCallbacks::onPassKeyDisplay() { return _owner.displayPasskey(); }

void CharacteristicDataCallbacks::onWrite(NimBLECharacteristic* chr, NimBLEConnInfo& info) {
    if (!_owner.canAcceptInput(info)) return;
    const auto value = chr->getValue();
    _owner.receive(value.data(), value.size(), false);
}

void CharacteristicControlCallbacks::onRead(NimBLECharacteristic* chr, NimBLEConnInfo& info) {
    const uint8_t version = _owner.canAcceptInput(info) ? PROTOCOL_VERSION : 0;
    chr->setValue(&version, 1);
}

void CharacteristicControlCallbacks::onWrite(NimBLECharacteristic* chr, NimBLEConnInfo& info) {
    if (!_owner.canAcceptInput(info)) return;
    const auto value = chr->getValue();
    _owner.receive(value.data(), value.size(), true);
}
