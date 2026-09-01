# Porting Guide: DeskHop → BKMD

*How to carry DeskHop's mouse model into BKMD (Electron on PC1 + ESP32-S3 BLE
dongle on PC2). Companion docs in this folder: `ARCHITECTURE.md` (mental
model), `critical-path.md` (the mouse trace this guide builds on),
`modules.md`, `history.md`. DeskHop citations are `file:line` in the deskhop
repo; BKMD citations refer to this repo.*

The one-sentence takeaway: **stop mirroring relative deltas; keep a virtual
cursor in a fixed 0..32767 space and send PC2 absolute positions.** Everything
below is the working-out of that sentence.

---

## 1. Concept → BKMD mapping

| DeskHop concept | Where it lives in DeskHop | BKMD equivalent |
|---|---|---|
| Virtual cursor 0..32767, both axes | `structs.h:108-109`, `screen.h:20-21` | A `{x, y}` in Electron main process (e.g. in `keymonitor.ts` or a new `mousemonitor.ts`) |
| Accumulate deltas → clamp | `update_mouse_position`, mouse.c:122-146 | Same math in TS on each uiohook `mousemove`/raw delta |
| Edge-crossing gate (position + direction + speed) | `is_screen_switch_needed`, mouse.c:35-52 | Same predicate in TS; replaces/augments the `Cmd/Ctrl+Shift+R` toggle (CLAUDE.md flow step 5) |
| X flips to opposite edge on switch | mouse.c:201 | Same one-liner |
| Y linear remap between screens | `scale_y_coordinate`, mouse.c:159-187 | Same formula, but calibration is automatic (see §4) |
| Absolute HID mouse, logical max 0x7FFF | `usb_descriptors.h:71,101` | **New USB HID descriptor in the firmware** — the dongle enumerates to PC2 as an absolute pointer (digitizer-style), not a relative mouse |
| Relative HID interface kept for workarounds | usb_descriptors.c:70-81 | Keep the existing 4-byte relative path (`ble_server.h`) as a fallback/gaming mode |
| UART 12-byte packets between boards | uart.c:20-27 | Your BLE characteristic `1235` writes — add a new absolute-mouse payload (see §3) |
| Hotkey border calibration | handlers.c:28-52 | **Skip.** Electron knows PC1 geometry via `screen.getAllDisplays()`; PC2 size is one config field in the React UI |
| Cursor parking / key release on switch | mouse.c:268-292 | Same ideas, different mechanics: on switch, release all forwarded keys (you already fixed a stuck-key bug on disconnect — same routine) and park/hide the local cursor (§5) |

**Skip entirely** (hardware problems you don't have): PIO-USB host +
HID descriptor parsing (`hid_parser.c`, `hid_report.c`), dual-core task
tables/queues, flash layout/ramdisk/webconfig, board autoprobe, firmware-
over-UART. That's ~80% of DeskHop. Rationale in `critical-path.md` and
`history.md`.

## 2. The coordinate math (all of it)

Normalize on PC1 (Electron), using the display the cursor is on:

```ts
const SCALE = 32767;
// px, py = cursor position in pixels within the current display's bounds
vx = Math.round((px / (displayWidth  - 1)) * SCALE);
vy = Math.round((py / (displayHeight - 1)) * SCALE);
```

While forwarding to PC2, accumulate raw deltas into the virtual position
instead (DeskHop does exactly this, mouse.c:122-146):

```ts
vx = clamp(vx + dx * speedFactor, 0, SCALE);
vy = clamp(vy + dy * speedFactor, 0, SCALE);
```

Edge crossing PC1 → PC2 (assuming PC2 is to the right of PC1):

```ts
if (vx >= SCALE && dx > 0 && Math.abs(dx) > jumpThreshold) {
  mode = "FORWARD";
  vx = 0;                       // flip to opposite edge (mouse.c:201)
  vy = remapY(vy);              // §4
}
```

DeskHop also gates on speed so a slow drift doesn't switch screens
(`get_jump_threshold`, mouse.c:19-32, made per-direction after a 2026 bug —
see history.md). Start with a single constant; add per-direction only if you
feel accidental switches.

## 3. BLE + USB report changes (the firmware ask for @Dubleriino)

Current DATA characteristic (`ble_server.h`): 8-byte keyboard, 4-byte
relative mouse `(buttons, dx, dy, wheel)`. Add a third payload, distinguished
by length (consistent with the existing length-dispatch in `DecoderTask`):

```
6 bytes → absolute mouse: buttons u8, x u16-LE, y u16-LE, wheel i8
          x, y in 0..32767
```

Firmware side: add a second USB HID report (or interface) whose descriptor
declares X/Y as absolute with `LOGICAL_MAXIMUM 0x7FFF` — copy the shape of
DeskHop's descriptor (`usb_descriptors.h`, the ABS variant). The OS then maps
0..32767 to the full screen by itself; the firmware just replays the report,
exactly like it replays keyboard reports today. Keep the 4-byte relative
report working — DeskHop keeps both interfaces because some situations
(games, some OS operations) only behave with relative motion
(usb_descriptors.c:70-81, history.md macOS saga).

Per your CLAUDE.md convention: this change spans the BLE boundary, so it
touches **both** `apps/electron/src/electron/bluetooth-manager.ts` /
mouse-sending code **and** `firmware/BKMD_firmware/src/ble/ble_server.h` +
the USB HID descriptor. Wire format must agree on both sides.

## 4. Y remap without hotkeys

DeskHop needs user-recorded `border.top/bottom` per screen because the
firmware is blind (screen.h:27-31, handlers.c:28-52). BKMD's Electron side
can see: `screen.getAllDisplays()` gives PC1's exact bounds; ask the user
once for PC2's resolution (one field in the React UI) or let them nudge an
alignment offset visually.

If both screens are treated as full-range (top of PC1 maps to top of PC2),
`remapY` is identity — ship that first. The linear remap only matters when
monitors are physically offset or differently sized and you want seamless
edge alignment; then it's DeskHop's formula (mouse.c:159-187):

```ts
// [aTop..aBottom] on PC1's edge maps onto [bTop..bBottom] on PC2's edge,
// all in 0..32767 virtual units
remappedY = bTop + ((vy - aTop) * (bBottom - bTop)) / (aBottom - aTop);
```

## 5. The Electron-side state machine

```
        ┌──────────── LOCAL ────────────┐
        │ track cursor via uiohook       │
        │ normalize to 0..32767          │
        │ keyboard NOT forwarded         │
        └───────┬───────────────▲───────┘
   edge-crossing predicate      │ opposite-edge crossing
   true (or hotkey)             │ (or hotkey — keep it as escape hatch)
        ┌───────▼───────────────┴───────┐
        │           FORWARD              │
        │ suppress local input (key      │
        │  blocker + cursor handling)    │
        │ accumulate deltas → virtual pos│
        │ send 6-byte abs reports on     │
        │  change (rate-limit ~125 Hz)   │
        │ on BLE disconnect: release all │
        │  keys, fall back to LOCAL      │
        └───────────────────────────────┘
```

Notes:

- **Keep the global shortcut** as a manual override; DeskHop keeps its
  hotkey switch too (`output_toggle_hotkey_handler` path). The edge model
  augments it, it doesn't replace it.
- **Local cursor suppression is your hard problem** — DeskHop never has it
  (each PC has its own board; the physical mouse isn't attached to the PC
  being left). uiohook-napi observes but does not block mouse movement.
  Options to evaluate: park the cursor at the edge each event via a native
  call, hide it under a transparent always-on-top window, or accept visible
  local movement in v1 (unverified — needs a spike per OS).
- **On switch or disconnect, send an all-zero keyboard report and a
  buttons=0 mouse report** to PC2 before/after transitions. Half of
  DeskHop's mouse.c churn is stuck keys/drags across switches
  (history.md: the macOS drag bug, the stuck-key fixes).

## 6. Budget expectations (the history.md lesson)

DeskHop's coordinate model has barely changed since mid-2024; ~80% of its
ongoing commits are OS-boundary workarounds (macOS absolute-pointer quirks,
device oddities). Expect the same shape: §2's math is a day of work; cursor
suppression on PC1 and how Windows/macOS treat your absolute HID descriptor
on PC2 is where the weeks go. Test the absolute descriptor on PC2's actual
OS early — before building the state machine on top of it.
