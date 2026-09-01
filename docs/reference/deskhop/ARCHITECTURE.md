# DeskHop Architecture — The Mental Model

*Synthesis of a read-only deep dive. Companion notes: `notes/critical-path.md`
(mouse movement traced end to end), `notes/modules.md` (module map),
`notes/history.md` (why the gnarly parts are gnarly). Claims cite `file:line`.*

---

## 1. What you are looking at

Firmware (C11, ~3,900 lines in `src/`) for a hardware KVM switch: **two
identical RP2040 boards, one per computer, joined by a UART serial cable.**
Each board presents itself to its computer as a permanently-attached
keyboard + mouse (USB *device* role) while also hosting the real keyboard or
mouse on a second, software-emulated USB port (USB *host* role, bit-banged via
the RP2040's PIO engine — `Pico-PIO-USB/`, CMakeLists.txt:36-52). The build
produces one flashable file, `build/deskhop.uf2` (CMakeLists.txt:98-149); the
same binary runs on both boards, which discover their own identity (A or B) at
boot by electrically probing a pin (`board_autoprobe`, src/setup.c:77-105).

There is no OS and no threads. Each of the two CPU cores runs an infinite
loop over a static task table, firing each task at a fixed frequency
(src/main.c:26-48, 52-69; scheduler at src/tasks.c:14). Core 0 owns the
USB-device side (talking to the PC); core 1 owns the USB-host side (reading
your real devices) plus the UART link.

**For readers from the JS world:** `main()` is the entry point and the "event
loop" is a literal `while (true)`. There is no GC and no module system —
every file includes the umbrella header `main.h` (src/include/main.h:20-47)
and reads/writes one shared global store.

## 2. The one global store

All runtime state is a single global struct: `device_t global_state`
(src/main.c:14; the struct: src/include/structs.h:93-152). Config that
persists across reboots is the nested `config_t` (src/include/structs.h:68-87),
loaded from the last 4 KB of flash or from compiled defaults
(src/utils.c:74-96, src/defaults.c:14-64).

Cross-core traffic flows through four multicore-safe queues inside that
struct — `kbd_queue`, `mouse_queue`, `uart_tx_queue`, `hid_queue_out`
(src/include/structs.h:113-116). **Everything else in `global_state` is
shared between cores with no locks** (see Trap #1).

## 3. The coordinate model (the heart of the project)

- DeskHop keeps a **virtual cursor**: `pointer_x`/`pointer_y`
  (src/include/structs.h:108-109) in a fixed space of **0..32767 on both
  axes** (src/include/screen.h:20-21). Pixels never appear in the code.
- Each PC sees an **absolute pointing device** with HID logical range
  0..0x7FFF (src/include/usb_descriptors.h:71, 101); the OS maps that range
  to the full screen itself, so one report format works on every
  resolution/OS with zero drift.
- The physical mouse still sends relative deltas; they are scaled
  (acceleration curve src/mouse.c:70-119, per-output speed src/mouse.c:131-133)
  and accumulated into the virtual position, clamped to the screen
  (src/mouse.c:139-140).
- Crossing an edge = coordinate math, not events: X flips to the opposite
  edge (src/mouse.c:201), Y is linearly remapped between screens of different
  heights using two calibration values per output, `border.top/bottom`
  (`scale_y_coordinate`, src/mouse.c:159-187; semantics
  src/include/screen.h:27-31; user records them with a hotkey,
  src/handlers.c:28-52).
- A second, *relative* mouse HID interface exists purely for OS workarounds
  (gaming mode, Windows extra desktops, macOS desktop-switch nudges) —
  `tud_mouse_report` picks the interface per report
  (src/usb_descriptors.c:70-81).

## 4. The four data paths

```
INPUT (core 1)                                   OUTPUT (core 0)
real mouse/kbd ──PIO-USB──► tuh_hid_report_received_cb (src/usb.c:212)
   │  descriptor parsed once at plug-in (src/hid_parser.c:172)
   ▼
process_mouse_report (src/mouse.c:348) / process_keyboard_report (src/keyboard.c:294)
   │
   ├── this PC active ──► mouse_queue/kbd_queue ──► drain tasks @2kHz
   │                      (src/mouse.c:383, src/keyboard.c:219) ──► TinyUSB ──► PC
   │
   └── other PC active ─► uart_tx_queue ──► 12-byte framed packet, DMA
                          (src/uart.c:20-55)
                             │  [START1|START2|type|8 bytes|checksum]
                             ▼  other board:
                          packet_receiver_task (src/tasks.c:227)
                             ──► dispatch table (src/uart.c:61-92)
                             ──► handlers.c ──► its local queues ──► its PC
```

The same UART link also carries: output switching (`OUTPUT_SELECT_MSG`,
src/handlers.c:191), border-calibration sync (src/handlers.c:224-235),
config proxying so one USB cable configures both boards
(src/handlers.c:270), LED state, heartbeats, and **entire firmware images**
(boards can flash each other: src/tasks.c:193-225, staging area in
misc/memory_map.ld:42).

## 5. The management plane

- Flash is hand-partitioned by the linker script (misc/memory_map.ld:24-48):
  188 KB program + 64 KB embedded FAT disk + 4 KB metadata/CRC + 256 KB
  firmware staging + 4 KB config at the very end.
- The board can present as a USB drive (src/ramdisk.c) serving `config.htm`
  (built from `webconfig/`); the page talks to the firmware over a vendor
  HID interface.
- The config API is a table mapping index → `offsetof(device_t, field)`
  (src/protocol.c:14-69). Reads/writes literally memcpy at that offset.
  Fields 14/15/44/45 are the screen-border calibration values.
- Config mode is entered by hotkey and survives the reboot via magic words
  in watchdog scratch registers (src/setup.c:112-124).

## 6. Recipes for common changes

- **New hotkey:** add an entry to the table at src/keyboard.c:18-109 pointing
  to a handler you add in src/handlers.c (declare it in
  src/include/handlers.h).
- **New inter-board message:** add a type to `enum packet_type_e`
  (src/include/protocol.h), a handler in src/handlers.c, and a row in the
  dispatch table at src/uart.c:61-92. Payload ≤ 8 bytes (Trap #4).
- **New persisted config field:** add to `config_t` **at the end, before
  `checksum`** (src/include/structs.h:82-86), set a default
  (src/defaults.c), bump the config version, add a row to the API field map
  (src/protocol.c) with a **new unused index**, and expose it in
  `webconfig/` templates. See Trap #2 before touching this.
- **Tune switching behavior:** everything is in src/mouse.c —
  `is_screen_switch_needed` (gate), `do_screen_switch` (decision tree),
  `switch_to_another_pc` / `switch_virtual_desktop` (actions).

---

## 7. TRAPS — non-obvious things that will bite you

1. **No locks.** Only the four queues are multicore-safe. Any other field of
   `global_state` you touch from both cores is a data race that happens to
   work because values are small and aligned. Pattern to follow: cores
   communicate via queues or via single small flag writes, never
   read-modify-write from both sides. (Queues: src/include/structs.h:113-116.)

2. **Struct layout is an ABI, three times over.** (a) The config API
   addresses fields by `offsetof` into `device_t` (src/protocol.c:14-69) —
   reordering fields silently retargets the webconfig UI's reads/writes.
   (b) `config_t` is the on-flash format — changing it without bumping the
   version/magic (src/include/structs.h:69-70, src/defaults.c:15-16) makes
   old stored configs load as garbage... actually a checksum+version check
   guards load (src/utils.c:74-96), so the real failure is silent fallback
   to defaults. (c) Packed structs like `mouse_report_t`
   (src/include/structs.h:34-41) are USB wire formats — field order/size is
   what the OS parses.

3. **Two boards must stay in agreement.** `active_output`, `pointer_x/y`,
   borders, LEDs all exist on *both* boards and are reconciled only by
   explicit UART messages (e.g. src/handlers.c:179-197, 224-235;
   src/mouse.c:200 → src/handlers.c:389). If you add state that affects
   behavior on both sides and forget the sync message, the boards diverge
   and the bug only shows when input enters on one board and exits the other.

4. **UART payload is 8 bytes, hard limit.** The packet format is fixed at 12
   bytes total (src/uart.c:20-27). Bigger data must be chunked (the firmware
   upgrade does exactly this, one byte-request at a time,
   src/tasks.c:193-225) — note even `uint64_t` config values are clamped to
   7 bytes in the API map (src/protocol.c:33-35).

5. **The weird code is load-bearing.** The macOS 5×-relative-nudge loop
   (src/mouse.c:205-235), the all-zeros mouse report guard
   (src/mouse.c:355-363), the NKRO→boot fallback, the per-report-ID offset
   tracking — each looks wrong and each fixes a documented real-world device
   or OS bug (see notes/history.md). Run `git log -S "<code>"` before
   "simplifying" anything in mouse.c, hid_report.c, or hid_parser.c.

6. **Timing is fragile on core 1.** PIO-USB is software USB; core 1 also
   feeds a watchdog indirectly — it stamps a timestamp every loop
   (src/main.c:65) and core 0 reboots the chip if that goes stale
   (src/tasks.c:28-45). Long blocking work (flash writes, busy loops, printf
   over CDC) on core 1 can glitch USB or trigger a watchdog reboot. Related:
   the whole program runs from RAM (`PICO_COPY_TO_RAM`, CMakeLists.txt:27)
   partly so flash access latency can't stall time-critical code
   (unverified motive, but consistent with flash-write code carefully
   disabling interrupts, src/utils.c:62-72).

7. **USB interface numbering is mode-dependent.** Normal, config-mode, and
   debug builds expose different interface lineups
   (src/usb_descriptors.c:55-68; `ITF_NUM_*` in
   src/include/usb_descriptors.h). Off-by-one interface numbers have caused
   subtle, mode-specific bugs twice in history (notes/history.md). If you
   add an interface, audit every mode.

8. **The build has a hidden second half.** `deskhop.uf2` is not just
   compiled C: post-build steps compute a CRC32 and splice it into a
   metadata section, and the FAT disk image from `disk/` is linked in as a
   binary blob (CMakeLists.txt:100-151, disk/disk.S). The webconfig HTML
   must be rendered (`webconfig/ && make`) and the disk image built
   (`disk/create.sh`) before the firmware build for those parts to be
   current (.github/workflows/build.yml:28-42). A stale `disk.img` means
   your webconfig changes silently don't ship.

9. **C has no guardrails (for the TS-native reader).** Fixed-size arrays and
   `memcpy` with a wrong length don't throw — they corrupt neighboring
   memory and fail somewhere else entirely. When editing, mirror the
   existing bounds-check style (e.g. src/usb.c:215-216,
   src/hid_parser.c length checks) and never grow a buffer's *use* without
   growing its *declaration* (sizes live in src/include/*.h).

10. **Hotkeys are on the input side.** Hotkey detection runs on the board
    that physically hosts the keyboard, *before* forwarding
    (src/keyboard.c:294-330) — an action either runs locally or must be
    turned into a UART message (`_screensaver_set` shows the pattern,
    src/handlers.c:36-41). Assuming "this code runs on the board I'm
    thinking of" is the #1 way to write a change that works on your desk
    and fails on the other board.

## 8. If you remember only five things

1. One global struct; queues are the only safe cross-core channel.
2. Virtual absolute space 0..32767; the OS does the pixel mapping; edges
   are pure math.
3. Two boards, one binary, roles autoprobed; agreement is maintained only
   by explicit UART messages with 8-byte payloads.
4. Struct layout = API = flash format = wire format. Append, version, never
   reorder.
5. Ugly code in mouse.c and hid_* is scar tissue from real devices — check
   history before touching it.
