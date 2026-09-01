#include "ble_callbacks.h"
#include "ble_server.h"
#include <NimBLEDevice.h>
#include <algorithm>

namespace {
constexpr uint16_t CONN_INTERVAL_MIN = 6;  // 7.5 ms
constexpr uint16_t CONN_INTERVAL_MAX = 12; // 15 ms
constexpr uint16_t CONN_LATENCY = 0;
constexpr uint16_t CONN_TIMEOUT = 200;     // 2 seconds
}

void ServerCallbacks::onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) {
    Serial.printf("Client address: %s\n", connInfo.getAddress().toString().c_str());
    _owner.setConnected(connInfo.getConnHandle());

    pServer->updateConnParams(
        connInfo.getConnHandle(),
        CONN_INTERVAL_MIN,
        CONN_INTERVAL_MAX,
        CONN_LATENCY,
        CONN_TIMEOUT
    );
}

void ServerCallbacks::onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) {
    Serial.println("Client disconnected");
    _owner.handleDisconnected();

    if (_owner.advEnabled()) {
        NimBLEDevice::startAdvertising();
    } else {
        Serial.println("Advertising suppressed (soft stop)");
    }
}

void ServerCallbacks::onMTUChange(uint16_t mtu, NimBLEConnInfo& connInfo) {
    Serial.printf("MTU updated: %u for connection ID: %u\n", mtu, connInfo.getConnHandle());
}

void CharacteristicDataCallbacks::onWrite(
    NimBLECharacteristic* characteristic,
    NimBLEConnInfo&
) {
    const std::string value = characteristic->getValue();
    if (value.empty()) return;

    BlePacket packet{};
    packet.type = BlePacketType::HidReport;
    packet.len = static_cast<uint16_t>(std::min(value.size(), BLE_MAX_PAYLOAD));
    memcpy(packet.data, value.data(), packet.len);

    if (xQueueSend(_q, &packet, 0) != pdTRUE) {
        Serial.println("BLE HID queue full; report dropped");
    }
}
