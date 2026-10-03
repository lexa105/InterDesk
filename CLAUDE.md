# CLAUDE.md

Guidance for Claude Code (and future contributors) working in this repository.

## What this project is

InterDesk (renamed 2026-09 from BKMD, "Bluetooth Keyboard Mouse Dongle" — the old name still
survives in internal identifiers, see "Conventions & gotchas") lets you control one computer
("**PC2**", the target) using the keyboard and mouse of another computer ("**PC1**",
typically a laptop), over BLE, via a custom ESP32-S3 USB dongle.

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
app/            Active cross-platform desktop app (Electron + React + Tailwind + TypeScript)
firmware/
  InterDesk_firmware/    Active ESP32-S3 firmware (PlatformIO + Arduino framework + NimBLE)
  platformio/            Local scratch PlatformIO scaffold, gitignored, not part of the build
docs/           Project docs; docs/reference/deskhop/ holds the DeskHop analysis (see below).
                Its reference/, sessions/ and getting-started.md are gitignored — see the note
                below.
img/            README assets
archive/        Retired, not maintained — ignore unless asked. Gitignored. macOS-prototype/
                (the frozen Swift/SwiftUI app) and python-scripts/ (early spike scripts).
```

**Local-only paths (gitignored as of 2026-09).** `archive/`, `docs/reference/`, `docs/sessions/`
and `docs/getting-started.md` were untracked and added to `.gitignore` — they live on the primary
maintainer's machine only. A fresh clone will not have them, so every reference to them in this
file (including the DeskHop section below) is a dead pointer outside that working copy. If you are
on a clone that lacks them, say so instead of guessing at their contents; ask the maintainer to
share the file.

Ownership split: the desktop app is developed by the primary maintainer
(lexatuan@gmail.com); firmware is developed by hardware collaborator **@Dubleriino**. Firmware
source comments are frequently written in Czech.

## Current implementation status

The app and firmware now use secure protocol v2. Read
[`docs/input-and-ble.md`](docs/input-and-ble.md) before changing capture, queueing,
pairing, or the wire protocol. It documents the current behavior and hardware checks.

- DATA characteristic `1235` remains 8-byte keyboard / 4-byte relative mouse /
  6-byte absolute mouse, on service `B00B`.
- CONTROL `1236` is an authenticated version read (`2`) and reset (`0`) / heartbeat (`1`) write.
- Both characteristics require passkey-authenticated LE Secure Connections. Pairing
  is opened by holding/releasing GPIO0 for 2s, or 8s to erase bonds. No insecure fallback.
- The app serializes acknowledged writes, coalesces motion, expires input, and
  invalidates old callbacks at disconnect. Native and overlay capture also check age.
- The pointer-lock overlay is implemented for both mouse modes. Unlocked movement
  falls back to uiohook coordinates; the two sources are explicitly exclusive.
- Firmware releases input on disconnect, inactivity, overflow and USB failure;
  failed USB releases are retried after resume.
- Linux secure connections are explicitly unsupported by the present Noble HCI
  backend. macOS/Windows native pairing and latency need real-device verification.
- UI/preload/main DTOs live in `app/src/shared/contracts.d.ts` (type-only).

Historical local-only DeskHop notes may be absent in fresh clones. Current tracked
protocol and implementation documentation is in `docs/input-and-ble.md`.

## Building & running

### Electron app (`app`)

```bash
npm install
npm run dev          # runs Vite (React UI) + Electron concurrently
npm run build         # type-check + production build
npm run dist:mac      # package a macOS .dmg/.app (arm64)
npm run dist:win       # package for Windows
npm run dist:linux     # package for Linux
npm run check        # lint + tests + Electron/preload compile + renderer build
```

Key files:
- `src/electron/main.ts` — app lifecycle, global shortcut registration, wiring `KeyMonitor` →
  `BluetoothManager`
- `src/electron/keymonitor.ts` — global key capture + HID report construction
- `src/electron/bluetooth-manager.ts` — BLE central role (scan/connect/write) via `noble`
- `src/ui/` — React/Tailwind renderer (functional: device list, dongle settings, keybind
  recorder, switching/arrangement page — all wired over the `window.bkmd` preload bridge)

### Firmware (`firmware/InterDesk_firmware`)

PlatformIO project with two environments:
- `esp32-s3-devkitc-1` — generic ESP32-S3 dev board, no display
- `lilygo-t-dongle-s3` — LilyGO T-Dongle S3 (USB-A form factor, has a TFT display) — the actual
  target hardware for this project

```bash
pio run -e lilygo-t-dongle-s3            # build
pio run -e lilygo-t-dongle-s3 -t upload   # build + flash
pio device monitor -b 115200               # serial log
```

The display configuration is included from `firmware/User_Setup.h` automatically. Its
existing pins differ from official LilyGO wiring; confirm the physical board before changing them.

## Reference material: DeskHop analysis

`docs/reference/deskhop/` (**local-only — gitignored, absent from fresh clones**) contains a
deep-dive analysis of the DeskHop firmware (https://github.com/hrvach/deskhop), an open-source
hardware KVM whose mouse model InterDesk is adopting. It is the design blueprint for replacing today's relative-delta mouse forwarding with
an **absolute-coordinate model**: a virtual cursor in a fixed 0..32767 space, edge-crossing
detection to switch machines, and the dongle enumerating as an absolute HID pointer to PC2.

- `porting-guide.md` — **start here**: DeskHop concept → InterDesk equivalent, the exact coordinate
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

- HID usage-code mapping in `keymonitor.ts` (`HID_KEY_MAP`) is keyed on **macOS** `uiohook-napi`
  keycodes — it has not been verified against Windows/Linux keycodes despite the app targeting
  all three via Electron.
- Several files mix English and Czech comments/TODOs (e.g. `main.cpp`, `keymonitor.ts`) — this is
  normal for this repo given the two collaborators; don't "clean up" language when editing nearby
  code unless asked.
- Do not touch anything under `archive/` unless explicitly asked — it's excluded from the active
  app/firmware work described above.
- The rename to InterDesk covered user-visible surfaces only. Internal identifiers deliberately
  still say bkmd: the `window.bkmd` preload bridge and its `BkmdApi` type, and the
  `bkmd-capture-overlay` session partition. Leave them alone unless asked to rename them —
  changing the bridge means touching the preload, the `.d.ts`, and every renderer call site at
  once. `settings-store.ts` reads the legacy `bkmd-settings.json` once for migration.
- When making changes that span the BLE boundary (report format, characteristic UUIDs, packet
  framing), update **both** `app/src/electron/keymonitor.ts` /
  `bluetooth-manager.ts` and `firmware/InterDesk_firmware/src/ble/ble_server.h` — they must agree on
  wire format since there's no shared schema/codegen between the two languages.
