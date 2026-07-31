#pragma once
#include <NimBLEDevice.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include <atomic>


class BleServer;

struct BleRxStats {
    uint32_t received;
    uint32_t queued;
    uint32_t dropped;
    uint32_t maxQueueDepth;
};

class ServerCallbacks : public NimBLEServerCallbacks {
public:
    //
    explicit ServerCallbacks(BleServer& owner) : _owner(owner) {} //passed by referencing to actual object with *this

    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override;
    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override;
    void onMTUChange(uint16_t MTU, NimBLEConnInfo& connInfo) override;
private:
    BleServer& _owner;
};



class CharacteristicDataCallbacks : public NimBLECharacteristicCallbacks {
public:
    explicit CharacteristicDataCallbacks(QueueHandle_t q) : _q(q) {}
    
    void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo& connInfo) override;
    BleRxStats stats() const;

private:
    QueueHandle_t _q;
    std::atomic<uint32_t> _received{0};
    std::atomic<uint32_t> _queued{0};
    std::atomic<uint32_t> _dropped{0};
    std::atomic<uint32_t> _maxQueueDepth{0};
};
