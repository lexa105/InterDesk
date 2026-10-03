#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <map>
constexpr uint16_t BLE_HS_CONN_HANDLE_NONE = 0xffff;
constexpr uint8_t BLE_HS_IO_DISPLAY_ONLY = 0;
namespace NIMBLE_PROPERTY {
constexpr unsigned READ = 1, WRITE = 2, READ_ENC = 4, READ_AUTHEN = 8, WRITE_ENC = 16, WRITE_AUTHEN = 32;
}
struct NimBLEUUID {
    std::string value;
    NimBLEUUID(const char* value) : value(value) {}
};
struct NimBLEConnInfo {
    uint16_t handle = 1;
    bool encrypted = false;
    bool authenticated = false;
    uint8_t keySize = 16;
    uint16_t getConnHandle() const { return handle; }
    int getIdAddress() const { return 1; }
    bool isEncrypted() const { return encrypted; }
    bool isAuthenticated() const { return authenticated; }
    uint8_t getSecKeySize() const { return keySize; }
};
class NimBLEServer;
class NimBLECharacteristic;
struct NimBLEServerCallbacks {
    virtual void onConnect(NimBLEServer*, NimBLEConnInfo&) {}
    virtual void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) {}
    virtual void onAuthenticationComplete(NimBLEConnInfo&) {}
    virtual uint32_t onPassKeyDisplay() { return 123456; }
};
struct NimBLECharacteristicCallbacks {
    virtual void onRead(NimBLECharacteristic*, NimBLEConnInfo&) {}
    virtual void onWrite(NimBLECharacteristic*, NimBLEConnInfo&) {}
};
struct NimBLECharacteristic {
    unsigned properties = 0;
    NimBLECharacteristicCallbacks* callbacks = nullptr;
    std::vector<uint8_t> value;
    void setCallbacks(NimBLECharacteristicCallbacks* cb) { callbacks = cb; }
    std::vector<uint8_t> getValue() const { return value; }
    void setValue(const uint8_t* data, size_t length) { value.assign(data, data + length); }
};
struct NimBLEService {
    std::map<std::string, NimBLECharacteristic> characteristics;
    NimBLECharacteristic* createCharacteristic(const NimBLEUUID& uuid, unsigned properties, size_t) {
        auto& chr = characteristics[uuid.value]; chr.properties = properties; return &chr;
    }
};
struct NimBLEAdvertising {
    unsigned starts = 0;
    void setName(const char*) {}
    void addServiceUUID(const NimBLEUUID&) {}
    void enableScanResponse(bool) {}
    void start() { starts++; }
};
struct NimBLEServer {
    NimBLEServerCallbacks* callbacks = nullptr;
    NimBLEService service;
    unsigned disconnects = 0;
    void setCallbacks(NimBLEServerCallbacks* cb, bool) { callbacks = cb; }
    NimBLEService* createService(const NimBLEUUID&) { return &service; }
    void start() {}
    void disconnect(uint16_t) { disconnects++; }
    void updateConnParams(uint16_t, uint16_t, uint16_t, uint16_t, uint16_t) {}
};
struct NimBLEDevice {
    inline static NimBLEServer server;
    inline static NimBLEAdvertising advertising;
    inline static bool bonded = false;
    inline static bool mitm = false;
    inline static bool secureConnections = false;
    static void init(const char*) { server = {}; advertising = {}; }
    static void setSecurityAuth(bool, bool auth, bool sc) { mitm = auth; secureConnections = sc; }
    static void setSecurityIOCap(uint8_t) {}
    static void setSecurityPasskey(uint32_t) {}
    static NimBLEServer* createServer() { return &server; }
    static NimBLEAdvertising* getAdvertising() { return &advertising; }
    static bool isBonded(int) { return bonded; }
    static void deleteAllBonds() { bonded = false; }
    static void startAdvertising() { advertising.start(); }
};
