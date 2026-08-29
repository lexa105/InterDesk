# CLAUDE.md

Guidance for Claude Code (and future contributors) working in this repository.

## What this project is

BKMD (Bluetooth Keyboard Mouse Dongle) lets you control one computer ("**PC2**", the target)
using the keyboard (and eventually mouse) of another computer ("**PC1**", typically a laptop),
over BLE, via a custom ESP32-S3 USB dongle.

Motivating use case: a desktop PC + a laptop set up side by side, where the laptop is physically
in front of/on top of the desktop's keyboard, leaving no room to use it. Instead of reaching
around, the user types on the laptop and those keystrokes are forwarded wirelessly to the desktop.

### Physical/data flow

```
Laptop (PC1)                         Desktop/target PC (PC2)
┌─────────────────────┐              ┌──────────────────────┐
│ Electron app         │   BLE        │  USB port              │
│  - KeyMonitor         │───────────▶│  ┌──────────────────┐  │
│    (uiohook-napi)     │  writes    │  │ ESP32-S3 dongle    │  │
│  - BluetoothManager   │  HID       │  │  - NimBLE server   │  │
│    (@stoprocent/noble)│  reports   │  │  - USB HID device  │──┼─▶ appears as a
└─────────────────────┘              │  │    (keyboard/mouse)│  │   real keyboard/mouse
                                      │  └──────────────────┘  │   to PC2
                                      └──────────────────────┘
```

1. The Electron app runs on the laptop (PC1) and hooks global keyboard events with
   `uiohook-napi`.
2. Keys are translated into standard USB HID usage codes and packed into an 8-byte HID
   boot-keyboard report.
3. The report is written over BLE to a characteristic exposed by the ESP32 dongle, which is
   plugged in via USB-A to PC2.
4. The dongle firmware (NimBLE peripheral + USB HID device) receives the report and replays it
   over USB HID, so PC2's OS sees a normal hardware keyboard/mouse.
5. A global shortcut in the Electron app (`Cmd/Ctrl+Shift+R`) toggles whether local keystrokes
   are currently being captured/forwarded — this is the "switching" mechanism referenced
   throughout the code, meant to avoid sending input to both machines at once.

## Repo layout

```
apps/
  electron/     Active cross-platform desktop app (Electron + React + Tailwind + TypeScript)
  macOS/        Legacy native Swift/SwiftUI prototype — superseded, kept for reference only
firmware/
  BKMD_firmware/        Active ESP32-S3 firmware (PlatformIO + Arduino framework + NimBLE)
  platformio/            Local scratch PlatformIO scaffold, gitignored, not part of the build
docs/           Project docs; docs/reference/deskhop/ holds the DeskHop analysis (see below)
python-scripts/, protocol/   Out of scope / not actively maintained — ignore unless asked
```

Ownership split: application (Electron/macOS) is developed by the primary maintainer
(lexatuan@gmail.com); firmware is developed by hardware collaborator **@Dubleriino**. Firmware
source comments are frequently written in Czech.

## Current implementation status (as of 2026-08)

Working:
- Electron app: device discovery and connection UI, global shortcut start/stop of keyboard and
  mouse capture, and forwarding HID reports over BLE to a dongle.
- DeskHop-style **dynamic switching** (implemented 2026-08, not yet hardware-tested): a virtual
  cursor in 0..32767 space (`mousemonitor.ts` absolute mode), edge-crossing detection on PC1
  (`edge-switcher.ts`), and an absolute-pointer USB HID device on the dongle
  (`firmware/BKMD_firmware/src/usb/abs_mouse.*`). Settings: `dynamicSwitch`, `pc2Side`,
  `mouseMode` ('absolute'|'relative'). The global shortcut remains as manual switching.
- Firmware: receiving 8-byte keyboard, 4-byte relative-mouse, and 6-byte absolute-mouse reports
  over BLE and replaying them as USB HID; "AirDrop" advertising toggle via long button press;
  optional TFT status display on the LilyGO board variant.

Not yet working / explicitly TODO in code:
- **Local cursor suppression while forwarding**: uiohook only observes the cursor, so while
  forwarding the local macOS cursor pins at the physical screen edge and coordinate-derived
  deltas collapse to zero there (limits movement away from the entry edge on PC2). Planned fix:
  a pointer-capture overlay window feeding `MouseMonitor.applyDelta()` (already isolated for it).
- Screen-position calibration UI exists (`src/ui/components/SwitchingPage.tsx` — drag-to-arrange
  canvas writing `pc2Layout: { side, offset, scale }` via `settings:set-switching`), but the whole
  dynamic-switch pipeline is untested on real hardware.
- `apps/macOS` is frozen; do not add new features there — port relevant logic to
  `apps/electron` instead.

## BLE protocol (dongle firmware ↔ Electron app)

Defined in `firmware/BKMD_firmware/src/ble/ble_server.h`.

- Service UUID: `B00B`
- Characteristic `1235` ("DATA", write/write-without-response): HID reports
  - 8-byte payload → standard USB HID boot-keyboard report (`report[0]` = modifier bitmask,
    `report[2..7]` = up to 6 pressed HID usage codes)
  - 4-byte payload → relative mouse report (`buttons`, `dx`, `dy`, `wheel`)
  - 6-byte payload → absolute mouse report (`buttons` u8, `x` u16-LE, `y` u16-LE, `wheel` i8;
    x/y in the DeskHop-style 0..32767 virtual space, replayed via the dongle's absolute-pointer
    HID device so the host OS maps it to the full screen)

The firmware decodes the data channel through a FreeRTOS queue (`BlePacket`) consumed by
`DecoderTask` in `main.cpp`.

## Building & running

### Electron app (`apps/electron`)

```bash
npm install
npm run dev          # runs Vite (React UI) + Electron concurrently
npm run build         # type-check + production build
npm run dist:mac      # package a macOS .dmg/.app (arm64)
npm run dist:win       # package for Windows
npm run dist:linux     # package for Linux
npm run lint
```

Key files:
- `src/electron/main.ts` — app lifecycle, global shortcut registration, wiring `KeyMonitor` →
  `BluetoothManager`
- `src/electron/keymonitor.ts` — global key capture + HID report construction
- `src/electron/bluetooth-manager.ts` — BLE central role (scan/connect/write) via `noble`
- `src/ui/` — React/Tailwind renderer (functional: device list, dongle settings, keybind
  recorder, switching/arrangement page — all wired over the `window.bkmd` preload bridge)

### Firmware (`firmware/BKMD_firmware`)

PlatformIO project with two environments:
- `esp32-s3-devkitc-1` — generic ESP32-S3 dev board, no display
- `lilygo-t-dongle-s3` — LilyGO T-Dongle S3 (USB-A form factor, has a TFT display) — the actual
  target hardware for this project

```bash
pio run -e lilygo-t-dongle-s3            # build
pio run -e lilygo-t-dongle-s3 -t upload   # build + flash
pio device monitor -b 115200               # serial log
```

Note: the `lilygo-t-dongle-s3` env requires `TFT_eSPI`'s `User_Setup.h` to be configured after
first library download (see root README "Notes" section).

## Reference material: DeskHop analysis

`docs/reference/deskhop/` contains a deep-dive analysis of the DeskHop firmware
(https://github.com/hrvach/deskhop), an open-source hardware KVM whose mouse model BKMD is
adopting. It is the design blueprint for replacing today's relative-delta mouse forwarding with
an **absolute-coordinate model**: a virtual cursor in a fixed 0..32767 space, edge-crossing
detection to switch machines, and the dongle enumerating as an absolute HID pointer to PC2.

- `porting-guide.md` — **start here**: DeskHop concept → BKMD equivalent, the exact coordinate
  math, the proposed 6-byte absolute-mouse BLE payload, the Electron-side state machine, and
  which ~80% of DeskHop to ignore.
- `critical-path.md` — one mouse movement traced end to end through DeskHop (the model itself).
- `ARCHITECTURE.md` — DeskHop's overall mental model and traps.
- `modules.md`, `history.md` — module map and git archaeology (the OS-workaround lessons).

Consult `porting-guide.md` before changing mouse capture, switching logic, or the mouse wire
format. File:line citations in these docs refer to the DeskHop repo
(`~/Developer/deskhop`), not this one. The maintainer's background: React/TS below intermediate,
no C experience — explain C/firmware concepts as they come up.

## Conventions & gotchas

- HID usage-code mapping in `keymonitor.ts` (`MAC_HID_MAP`) is keyed on **macOS** `uiohook-napi`
  keycodes — it has not been verified against Windows/Linux keycodes despite the app targeting
  all three via Electron.
- Several files mix English and Czech comments/TODOs (e.g. `main.cpp`, `keymonitor.ts`) — this is
  normal for this repo given the two collaborators; don't "clean up" language when editing nearby
  code unless asked.
- Do not touch `python-scripts/` or `protocol/` unless explicitly asked — they're excluded from
  the active app/firmware work described above.
- When making changes that span the BLE boundary (report format, characteristic UUIDs, packet
  framing), update **both** `apps/electron/src/electron/keymonitor.ts` /
  `bluetooth-manager.ts` and `firmware/BKMD_firmware/src/ble/ble_server.h` — they must agree on
  wire format since there's no shared schema/codegen between the two languages.
