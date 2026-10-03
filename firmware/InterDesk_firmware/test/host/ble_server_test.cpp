#include <cassert>
#include <iostream>
#include "ble/ble_server.h"

struct Fixture {
    TestQueue queue{16, sizeof(BlePacket), {}};
    BleServer server{&queue};
    NimBLEConnInfo peer;
    Fixture() { testMillis = 100; NimBLEDevice::bonded = false; server.start(); }
    void pair() {
        server.openPairingWindow();
        assert(server.handleConnected(peer));
        peer.encrypted = peer.authenticated = true;
        server.handleAuthenticated(peer);
        assert(server.authorized());
    }
    BlePacket front() {
        BlePacket packet{};
        memcpy(&packet, queue.items.front().data(), sizeof(packet));
        return packet;
    }
    NimBLECharacteristic& data() { return NimBLEDevice::server.service.characteristics.at("1235"); }
    NimBLECharacteristic& control() { return NimBLEDevice::server.service.characteristics.at("1236"); }
};

int main() {
    {
        Fixture f;
        assert(NimBLEDevice::mitm && NimBLEDevice::secureConnections);
        assert(f.data().properties & NIMBLE_PROPERTY::WRITE_AUTHEN);
        assert(f.control().properties & NIMBLE_PROPERTY::READ_AUTHEN);
        assert(!f.server.handleConnected(f.peer));
        f.data().value = {0, 1, 2, 0};
        const auto size = f.queue.items.size();
        f.data().callbacks->onWrite(&f.data(), f.peer);
        assert(f.queue.items.size() == size); // Unauthenticated input is never queued.
    }
    {
        Fixture f;
        f.server.openPairingWindow();
        assert(f.server.pairingOpen());
        const auto code = f.server.pairingPasskey();
        assert(code < 1000000);
        assert(f.server.handleConnected(f.peer));
        assert(f.server.displayPasskey() == code);
        f.peer.encrypted = true; // Just Works encryption is insufficient.
        f.server.handleAuthenticated(f.peer);
        assert(!f.server.authorized());
        assert(NimBLEDevice::server.disconnects > 0);
    }
    {
        Fixture f;
        f.pair();
        assert(!f.server.pairingOpen());
        f.control().callbacks->onRead(&f.control(), f.peer);
        assert(f.control().value == std::vector<uint8_t>{PROTOCOL_VERSION});
        f.data().value = {0, 1, 2, 0};
        f.data().callbacks->onWrite(&f.data(), f.peer);
        assert(f.queue.items.size() == 2); // Initial reset + HID packet.
        const auto generation = f.server.generation();
        f.server.handleDisconnected(f.peer.handle);
        assert(!f.server.authorized());
        assert(f.queue.items.size() == 1);
        assert(f.front().type == BlePacketType::Reset);
        assert(f.server.generation() > generation);
    }
    {
        Fixture f;
        NimBLEDevice::bonded = true;
        assert(f.server.handleConnected(f.peer));
        f.peer.encrypted = f.peer.authenticated = true;
        f.server.handleAuthenticated(f.peer);
        assert(f.server.authorized()); // Bonded reconnect needs no pairing window.
        f.server.handleDisconnected(f.peer.handle);
        assert(f.server.handleConnected(f.peer));
        f.server.displayPasskey(); // Lost keys cannot silently re-pair outside the window.
        f.server.handleAuthenticated(f.peer);
        assert(!f.server.authorized());
    }
    {
        Fixture f;
        f.server.openPairingWindow();
        testMillis += PAIRING_WINDOW_MS;
        f.server.poll();
        assert(!f.server.pairingOpen());
        assert(!f.server.handleConnected(f.peer));
    }
    {
        Fixture f;
        f.pair();
        testMillis += LINK_IDLE_TIMEOUT_MS;
        const uint8_t heartbeat = 1;
        f.server.receive(&heartbeat, 1, true);
        f.server.poll();
        assert(f.server.authorized());
        testMillis += LINK_IDLE_TIMEOUT_MS + 1;
        f.server.poll();
        assert(!f.server.authorized());
        assert(f.front().type == BlePacketType::Reset);
    }
    {
        Fixture f;
        f.pair();
        const uint8_t invalid[9] = {};
        f.server.receive(invalid, sizeof(invalid), false);
        assert(f.queue.items.size() == 1); // Reject, never truncate to a valid report.
        const uint8_t report[4] = {};
        for (int i = 0; i < 16; i++) f.server.receive(report, sizeof(report), false);
        assert(!f.server.authorized());
        assert(f.queue.items.size() == 1);
        assert(f.front().type == BlePacketType::Reset); // Overflow fails closed.
    }
    {
        Fixture f;
        testMillis = UINT32_MAX - 100;
        f.pair();
        testMillis += 250;
        f.server.poll();
        assert(f.server.authorized()); // Watchdog arithmetic survives millis rollover.
    }
    std::cout << "8 firmware pairing/queue/watchdog scenarios passed\n";
}
