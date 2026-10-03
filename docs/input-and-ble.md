# Input transport and secure pairing

The desktop app and firmware use protocol **v2** and must be updated together.
Old firmware is rejected before forwarding is enabled.

## Pair once, reconnect normally

1. Plug the dongle into the target computer.
2. Hold its GPIO0 button for **2 seconds**, then release. Pairing opens for 60 seconds.
3. Scan and Connect in InterDesk. Enter the six-digit code displayed on the dongle
   in the laptop's system Bluetooth pairing dialog. Include leading zeroes.
4. Later connections use the stored Bluetooth bond, without another code.

If the OS does not open a pairing dialog automatically, pair from its Bluetooth
settings during the same window, then connect in InterDesk. If trust is lost,
remove the dongle from the laptop's Bluetooth settings, hold the dongle button
for **8 seconds and release** to erase its bonds, and pair again. The firmware
stores up to NimBLE's configured bond limit (currently three).

The generic board build prints the code to its USB serial console at 115200 baud
instead of a display. It needs a way for the owner to read that console; this is
less convenient than the display-equipped dongle.

The button now controls pairing; the old advertising-only “AirDrop” toggle has
been removed. There was no file-transfer implementation behind that toggle.

### Security boundary

- The official PlatformIO builds disable legacy pairing and require **LE Secure
  Connections**, bonding, passkey authentication, and a 16-byte encryption key.
  A compile-time assertion prevents an Arduino build with legacy pairing enabled.
- Both GATT characteristics require authenticated encryption. Callbacks also check
  the authenticated connection handle before accepting input.
- Unknown laptops require a physical pairing window. Merely advertising a matching
  name or service is not proof of trust; the first pairing code must match the
  physical dongle. Never enter a code supplied by a remote advertisement.
- Only one BLE connection is accepted at a time. Input queues are invalidated at
  disconnect, overflow, timeout, USB failure, and explicit input reset.
- Re-pairing is gated by the button. NimBLE 2.5.1 internally deletes a bond when it
  receives a repeat-pairing request before invoking the passkey callback. The app
  prevents an unauthorised replacement, but this upstream behavior can still
  invalidate a stored bond and force physical re-pairing (denial of service).
- Bond storage uses NimBLE's NVS persistence and the laptop's native Bluetooth
  store. Flash encryption/secure boot and physical extraction resistance are not
  implemented by this project.

Secure pairing currently requires Noble's native **macOS or Windows** driver.
The [Noble HCI pairing implementation](https://github.com/stoprocent/noble/blob/master/lib/hci-socket/smp.js)
used on Linux only implements legacy NoInputNoOutput pairing; it cannot meet these
requirements. The app returns an explicit error on Linux. Restoring secure Linux
support needs an OS-managed Bluetooth backend with authenticated bonding, rather
than disabling firmware security. OS pairing dialogs and bond persistence still
need physical verification on each supported laptop OS.

NimBLE configuration and security decisions were checked against the pinned
[2.5.1 source](https://github.com/h2zero/NimBLE-Arduino/tree/2.5.1/src), including
`esp_nimble_cfg.h`, `ble_sm.c`, and `NimBLEServer.cpp`.

## Protocol

Service UUID: `B00B`. UUID matching is case-normalized by Noble.

| Characteristic | Operation | Payload |
| --- | --- | --- |
| `1235` DATA | Write with response | 8-byte boot keyboard, 4-byte relative mouse, or 6-byte absolute mouse |
| `1236` CONTROL | Authenticated read | One byte: protocol version `2` |
| `1236` CONTROL | Write with response | `0`: discard pending input and release all controls; `1`: heartbeat |

DATA layouts are unchanged from the original project:

- Keyboard: modifier bitmask, reserved zero, six HID usage codes. More than six
  simultaneous non-modifier keys produce ErrorRollOver until the count recovers.
- Relative mouse: buttons, signed dx, signed dy, signed wheel.
- Absolute mouse: buttons, x as uint16 little-endian, y as uint16 little-endian,
  signed wheel. Coordinates span 0..32767.

Invalid lengths are rejected, never truncated into a valid report.
The desktop declares a connection usable only after discovering the exact service,
reading its protected version, and writing an input reset successfully.

## Latency and stale-input policy

`hid-transport.ts` owns the queue independently of Electron/Noble, which allows
repeatable tests using a simulated clock and driver.

| Limit | Value | Purpose |
| --- | --- | --- |
| Mouse sampling interval | 8 ms | Coalesce high-rate motion without delaying buttons/scroll intentionally |
| Maximum pending input age | 100 ms | Discard stale motion; stop forwarding if ordered key/button events expire |
| ATT write timeout | 250 ms | Stop and disconnect a stalled sender |
| Pending report bound | 32 | Fail closed instead of dropping a key/button release |
| Idle heartbeat interval | 250 ms | Let the dongle detect an app crash or suspended laptop |
| Dongle idle timeout | 1500 ms | Disconnect and release all controls when traffic stops |
| Firmware queue | 16 packets | Bounded buffering; age checked before USB delivery |
| USB report completion timeout | 10 ms | Avoid long USB stalls backing up the decoder |
| Requested BLE interval | 7.5–15 ms, latency 0 | Low-latency connection preference; the central chooses the actual interval |

There is **one acknowledged ATT write in flight**. Write-without-response callbacks
only report local driver acceptance and cannot establish that the dongle has
consumed the data. Acknowledged writes bound the hidden radio/OS backlog at the
cost of a round trip. No end-to-end latency improvement is claimed without a
hardware measurement; the changes remove per-report logging, redundant relative
USB reports, excessive relative report production, and unbounded sender queues.

Consecutive absolute motion keeps only the latest position. Consecutive fresh
relative motion accumulates into one signed-byte delta, clipping overflow rather
than draining it later. Buttons, wheel, and keyboard transitions remain ordered;
coalescing never crosses those barriers. Expired motion is discarded even if no
new movement arrives. A report already submitted to the radio or USB controller
cannot be recalled; this policy bounds that work rather than promising zero
post-disconnect reports.

Native input events retain their original capture age using a calibrated mapping
between libuiohook timestamps and a monotonic JS clock (nanoseconds on macOS,
wrapping milliseconds on Windows/X11). A native backlog stops forwarding and
releases controls. Pointer-lock IPC carries its capture timestamp and discards
old deltas. Only the locked overlay or the coordinate fallback supplies movement
at one time, preventing double movement. Both relative and absolute modes use
pointer lock when available.

The firmware timestamps reception, tags input with a connection/reset generation,
and drops stale or invalidated packets. Disconnects, stalled input and overflows
clear remote controls. USB releases are retried after suspension rather than
being forgotten if the first release cannot be delivered. Reconnection always
starts a new queue and leaves forwarding off until explicitly activated again.

## Code organization

- `app/src/shared/contracts.d.ts`: one source for renderer, preload and main-process
  API types; no runtime imports across the sandboxed CommonJS preload boundary.
- `bluetooth-manager.ts`: adapter events, scoped discovery, pairing/readiness,
  cancellation, disconnect cleanup, and transport ownership.
- `hid-transport.ts`: bounded ordered transmission, coalescing, expiry and heartbeat.
- `input-freshness.ts`: native timestamp normalization and age checks.
- `mousemonitor.ts` / `keymonitor.ts`: capture and HID state. The switch shortcut's
  trigger key is consumed before it can execute on the target computer.
- `settings-validation.ts`: validate disk data as well as IPC input; invalid modes,
  geometry and shortcuts cannot corrupt capture state. Writes use a temporary file
  and rename, and settings snapshots do not share their nested layout object.
- `firmware/.../ble/`: pairing policy, authenticated GATT callbacks and receive queue.
- `firmware/.../main.cpp`: USB decoding, release retries, physical button, display.

## Verification and remaining work

Run from a fresh checkout:

```sh
cd app
npm ci
npm run check
cd ../firmware/InterDesk_firmware
./test/host/run.sh
pio run
```

Desktop tests require Node 22.15 or later for native-module mocking. Firmware host
policy tests require a C++17 compiler. They compile the real BLE server/callback
code against test doubles; they do **not** emulate the Bluetooth stack or radio.
Both ESP32 targets are also compiled against the actual pinned NimBLE library.

Physical validation before relying on the new firmware:

1. Verify the display pins for the actual board, then check that the six-digit code
   is visible and matches the OS prompt. Existing wiring has been preserved.
2. Pair, power-cycle both sides, reconnect, and confirm no new code is needed.
3. Reject a wrong code and a pairing attempt with the physical window closed.
4. Hold a key/button, stall/kill the app or disable Bluetooth, then reconnect.
   Confirm release, no catch-up burst, and forwarding remains off.
5. Repeat with USB suspend/resume, both mouse modes, fast typing, dragging and wheel.
6. Record actual negotiated connection intervals and end-to-end latency, and tune
   the age/write/USB timeouts only from measurements.

The environment named `lilygo-t-dongle-s3` currently preserves the original
`firmware/User_Setup.h` GPIO assignments (10–14). These differ from the official
[LilyGO reference](https://github.com/Xinyuan-LilyGO/T-Dongle-S3/blob/main/examples/factory_screen/factory_screen.ino),
which uses LCD GPIOs 1–5 and backlight GPIO38. Confirm the hardware variant before
changing these pins or depending on display-based pairing. The build now includes
the tracked configuration directly; editing downloaded library files is unnecessary.

Remaining limitations:

- Local keyboard suppression still registers many OS shortcuts at a switch and
  cannot consume OS-reserved shortcuts or bare modifiers. Registration was moved
  before capture, but replacing it with a native suppression hook is the next
  meaningful latency/usability improvement and needs platform testing.
- Relative overflow clipping trades movement fidelity for bounded latency during
  overload. An absolute pointer can still jump directly to its latest position.
- Cross-platform key layouts, DPI behavior, pointer-lock availability and secure
  pairing UX need device testing; automated tests are not evidence of hardware compatibility.
- The compatible dependency refresh reduced the npm audit from 44 advisories
  (including two critical) to 16 high advisories on this review run. Remaining
  advisories include Electron and transitive packaging/BLE tooling dependencies.
  A supported Electron major upgrade and upstream dependency fixes remain necessary;
  `npm audit fix --force` was not used because it proposes major changes/downgrades.

The Linux unpacked-package check reached native dependency rebuilding but could
not finish in the review environment because `libudev.h` is missing. Install the
system development headers before packaging. Stale `electron-builder.json`
references to the nonexistent icon and preload/assets resources were removed;
the compiled preload is already included under `dist-electron/preload/`.
