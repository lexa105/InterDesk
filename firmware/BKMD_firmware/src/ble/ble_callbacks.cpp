#include "ble_callbacks.h"
#include "ble_server.h"
#include <NimBLEDevice.h>
#include <algorithm>
#include "esp_timer.h"

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
    _owner.setDisconnected();

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

    _received.fetch_add(1, std::memory_order_relaxed);

    BlePacket packet;
    packet.receivedUs = static_cast<uint32_t>(esp_timer_get_time());
    packet.len = static_cast<uint16_t>(std::min(value.size(), static_cast<size_t>(UINT16_MAX)));
    const size_t bytesToCopy = std::min(value.size(), HID_REPORT_MAX_SIZE);
    memcpy(packet.data, value.data(), bytesToCopy);

    if (xQueueSend(_q, &packet, 0) == pdTRUE) {
        _queued.fetch_add(1, std::memory_order_relaxed);

        const uint32_t depth = static_cast<uint32_t>(uxQueueMessagesWaiting(_q));
        uint32_t previousMax = _maxQueueDepth.load(std::memory_order_relaxed);
        while (depth > previousMax &&
               !_maxQueueDepth.compare_exchange_weak(
                   previousMax, depth, std::memory_order_relaxed)) {
        }
    } else {
        _dropped.fetch_add(1, std::memory_order_relaxed);
    }
}

BleRxStats CharacteristicDataCallbacks::stats() const {
    return {
        _received.load(std::memory_order_relaxed),
        _queued.load(std::memory_order_relaxed),
        _dropped.load(std::memory_order_relaxed),
        _maxQueueDepth.load(std::memory_order_relaxed)
    };
}
