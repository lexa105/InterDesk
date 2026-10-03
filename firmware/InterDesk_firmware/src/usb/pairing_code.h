#pragma once
#include <stdint.h>

struct PairingCodeRequest {
    uint32_t passkey;
    uint32_t requestedAt;
};

// Local button requests are short-lived too: never start typing later on USB
// resume, and abandon the remaining digits if USB stalls during delivery.
constexpr uint32_t PAIRING_CODE_MAX_PAUSE_MS = 100;
constexpr uint32_t PAIRING_CODE_REPORT_INTERVAL_MS = 10;

// Output supplies now(), ready(), matches(passkey), sendKeyboard(report), and
// pause(ms). Only the USB decoder calls this, so reports cannot interleave with
// remote input. The caller must retry an all-keys-up report after any failure.
template <typename Output>
bool typePairingCode(const PairingCodeRequest& request, Output& output) {
    uint32_t lastReportAt = output.now();
    if (request.passkey > 999999 ||
        lastReportAt - request.requestedAt > PAIRING_CODE_MAX_PAUSE_MS) return false;

    uint32_t divisor = 100000;
    // Initial release, then six press/release pairs. Leading/repeated zeroes
    // are preserved. No Enter, modifiers, or lock-key changes are generated.
    for (uint8_t step = 0; step < 13; ++step) {
        const uint32_t now = output.now();
        if (now - lastReportAt > PAIRING_CODE_MAX_PAUSE_MS ||
            !output.ready() || !output.matches(request.passkey)) return false;

        uint8_t report[8] = {};
        if (step % 2 == 1) {
            const uint8_t digit = (request.passkey / divisor) % 10;
            divisor /= 10;
            // USB HID Keyboard/Keypad page: keypad 1..9 = 0x59..0x61,
            // keypad 0 = 0x62. The host should have Num Lock enabled.
            report[2] = digit == 0 ? 0x62 : 0x59 + digit - 1;
        }
        if (!output.sendKeyboard(report)) return false;
        lastReportAt = now;
        if (step < 12) output.pause(PAIRING_CODE_REPORT_INTERVAL_MS);
    }
    return true;
}
