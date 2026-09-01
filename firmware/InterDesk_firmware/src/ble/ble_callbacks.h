#pragma once
#include <NimBLEDevice.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"


class BleServer;

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

private:
    QueueHandle_t _q;
};
