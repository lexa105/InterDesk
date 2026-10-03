#include <algorithm>
#include <array>
#include <cassert>
#include <iostream>
#include <string>
#include <vector>
#include "usb/pairing_code.h"

struct TestOutput {
    uint32_t clock = 100;
    uint32_t validPasskey = 120003;
    uint32_t pauseDuration = PAIRING_CODE_REPORT_INTERVAL_MS;
    bool usbReady = true;
    int failAt = -1;
    int cancelAt = -1;
    std::vector<std::array<uint8_t, 8>> reports;
    uint32_t now() const { return clock; }
    bool ready() const { return usbReady; }
    bool matches(uint32_t code) const {
        return code == validPasskey && static_cast<int>(reports.size()) != cancelAt;
    }
    bool sendKeyboard(const uint8_t (&report)[8]) {
        std::array<uint8_t, 8> copy{};
        std::copy(report, report + 8, copy.begin());
        reports.push_back(copy);
        return static_cast<int>(reports.size()) - 1 != failAt;
    }
    void pause(uint32_t) { clock += pauseDuration; }
};

void expectCode(uint32_t code, const std::string& digits) {
    TestOutput out;
    out.validPasskey = code;
    assert(typePairingCode({code, out.clock}, out));
    assert(out.reports.size() == 13);
    std::string typed;
    for (size_t i = 0; i < out.reports.size(); ++i) {
        const auto& report = out.reports[i];
        for (size_t byte = 0; byte < report.size(); ++byte) {
            if (byte != 2) assert(report[byte] == 0); // No modifiers/extra keys.
        }
        if (i % 2 == 0) assert(report[2] == 0); // Release between repeated digits.
        else {
            assert(report[2] >= 0x59 && report[2] <= 0x62); // Digits only; never Enter.
            typed += report[2] == 0x62 ? '0' : '1' + report[2] - 0x59;
        }
    }
    assert(typed == digits);
}

int main() {
    expectCode(0, "000000");
    expectCode(123, "000123");
    expectCode(120003, "120003");
    expectCode(456789, "456789");
    expectCode(999999, "999999");
    {
        TestOutput out;
        assert(!typePairingCode({1000000, 100}, out));
        assert(out.reports.empty());
    }
    {
        TestOutput out;
        out.clock = 201;
        assert(!typePairingCode({120003, 100}, out)); // Stale local request.
        assert(out.reports.empty());
    }
    {
        TestOutput out;
        out.usbReady = false;
        assert(!typePairingCode({120003, 100}, out)); // No deferred resume typing.
        assert(out.reports.empty());
    }
    {
        TestOutput out;
        out.pauseDuration = 101;
        assert(!typePairingCode({120003, 100}, out)); // Stall stops the sequence.
        assert(out.reports.size() == 1);
    }
    {
        TestOutput out;
        out.failAt = 2; // First digit's release is uncertain; never retry digits.
        assert(!typePairingCode({120003, 100}, out));
        assert(out.reports.size() == 3);
    }
    {
        TestOutput out;
        out.cancelAt = 2; // Pairing closed or replaced during typing.
        assert(!typePairingCode({120003, 100}, out));
        assert(out.reports.size() == 2);
    }
    {
        TestOutput out;
        out.clock = UINT32_MAX - 20;
        assert(typePairingCode({120003, out.clock}, out));
        assert(out.reports.size() == 13);
    }
    std::cout << "12 pairing-code HID scenarios passed\n";
}
