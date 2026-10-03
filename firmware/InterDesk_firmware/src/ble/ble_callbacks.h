#pragma once
#include <NimBLEDevice.h>

class BleServer;

class ServerCallbacks : public NimBLEServerCallbacks {
public:
    explicit ServerCallbacks(BleServer& owner) : _owner(owner) {}
    void onConnect(NimBLEServer* server, NimBLEConnInfo& info) override;
    void onDisconnect(NimBLEServer*, NimBLEConnInfo& info, int) override;
    void onAuthenticationComplete(NimBLEConnInfo& info) override;
    uint32_t onPassKeyDisplay() override;
private:
    BleServer& _owner;
};

class CharacteristicDataCallbacks : public NimBLECharacteristicCallbacks {
public:
    explicit CharacteristicDataCallbacks(BleServer& owner) : _owner(owner) {}
    void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo& info) override;
private:
    BleServer& _owner;
};

class CharacteristicControlCallbacks : public NimBLECharacteristicCallbacks {
public:
    explicit CharacteristicControlCallbacks(BleServer& owner) : _owner(owner) {}
    void onRead(NimBLECharacteristic* chr, NimBLEConnInfo& info) override;
    void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo& info) override;
private:
    BleServer& _owner;
};
