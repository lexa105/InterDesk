#pragma once
#include <Arduino.h>
#include <NimBLEDevice.h>
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "ble_callbacks.h"

// Protocol v2: service B00B. Both characteristics require authenticated encryption.
// DATA 1235: 8 bytes keyboard, 4 bytes relative mouse, 6 bytes absolute mouse.
// Keyboard: modifiers, reserved=0, six usages.
// Relative: buttons, dx i8, dy i8, wheel i8.
// Absolute: buttons, x u16-LE, y u16-LE (0..32767), wheel i8.
// CONTROL 1236: read => version byte 2; write 0 => release/reset, 1 => heartbeat.
// App and firmware must be upgraded together. No unsecured legacy fallback.
constexpr uint8_t PROTOCOL_VERSION = 2;
constexpr uint32_t MAX_INPUT_AGE_MS = 100;
constexpr uint32_t LINK_IDLE_TIMEOUT_MS = 1500;
constexpr uint32_t PAIRING_WINDOW_MS = 60000;
constexpr size_t BLE_MAX_PAYLOAD = 8;

static const NimBLEUUID SVC_UUID("B00B");
static const NimBLEUUID DATA_UUID("1235");
static const NimBLEUUID CONTROL_UUID("1236");
constexpr const char* SERVER_NAME = "InterDesk Dongle";

enum class BlePacketType : uint8_t { HidReport, Reset };
struct BlePacket {
    BlePacketType type;
    uint8_t len;
    uint8_t data[BLE_MAX_PAYLOAD];
    uint32_t receivedAt;
    uint32_t generation;
};

class BleServer {
public:
    explicit BleServer(QueueHandle_t rxQueue);
    void start();
    void poll();
    void openPairingWindow(bool eraseBonds = false);
    bool pairingOpen() const;
    uint32_t pairingPasskey() const { return _passkey.load(); }
    bool authorized() const { return _authorized.load(); }
    uint32_t generation() const { return _generation.load(); }
    bool handleConnected(NimBLEConnInfo& info);
    void handleAuthenticated(NimBLEConnInfo& info);
    void handleDisconnected(uint16_t handle);
    uint32_t displayPasskey();
    bool canAcceptInput(const NimBLEConnInfo& info) const;
    void receive(const uint8_t* data, size_t len, bool control);
    void failLink();

private:
    void resetInput();
    QueueHandle_t _rxQueue;
    NimBLEServer* _server = nullptr;
    ServerCallbacks _serverCallbacks;
    CharacteristicDataCallbacks _dataCallbacks;
    CharacteristicControlCallbacks _controlCallbacks;
    std::atomic<uint16_t> _connHandle{BLE_HS_CONN_HANDLE_NONE};
    std::atomic<bool> _authorized{false};
    std::atomic<bool> _closing{false};
    std::atomic<bool> _pairingOpen{false};
    std::atomic<uint32_t> _pairingStartedAt{0};
    std::atomic<uint32_t> _passkey{0};
    std::atomic<uint32_t> _lastPacketAt{0};
    std::atomic<uint32_t> _connectedAt{0};
    std::atomic<uint32_t> _generation{0};
    bool _knownPeer = false; // Accessed only by the NimBLE host task.
    bool _pairingRequested = false;
};
