# Module Map

All sizes are small: the whole firmware is ~3,900 lines across 17 `.c` files
(plus headers). "Module" here = one `.c` file + its header, per C convention.

## The one structural fact that matters

**There are no enforced module boundaries.** Every `.c` file includes the
umbrella header `main.h`, which includes *every other header*
(src/include/main.h:20-47). All state lives in one global `device_t
global_state` (src/main.c:14, struct at src/include/structs.h:93-152) that
every module reads and writes directly. So the "modules" below are conventions
of topic, not isolation — like a JS project where every file does
`import * as everything` and mutates one shared store object.

Data flows between the two CPU cores through four lock-free queues inside
`device_t` (src/include/structs.h:113-116): `kbd_queue`, `mouse_queue`,
`hid_queue_out`, `uart_tx_queue` (Pico SDK `queue_t`, which is
multicore-safe). **Everything else in `global_state` is shared across cores
without locks** — plain reads/writes of small ints, which works on this
hardware but is a trap for newcomers (see Phase 5).

---

## Foundation

### main.c (71 lines) — entry point & scheduling
- Responsibility: define the two per-core task tables and run them forever
  (src/main.c:26-33, 52-60).
- Public surface: `main()`, `core1_main`, plus owning `global_state`.
- Depends on: everything (via task function pointers).

### tasks.c — scheduler + misc periodic tasks
- `task_scheduler` runs a task when `time >= next_run` (src/tasks.c:14).
- Also home to: `usb_device_task`/`usb_host_task` (thin TinyUSB wrappers,
  src/tasks.c:47-54), watchdog kick (src/tasks.c:28), screensaver
  (pong/jitter cursor animations, src/tasks.c:56-140), heartbeat
  (src/tasks.c:142), firmware-upgrade pump (src/tasks.c:193), UART RX
  ring-buffer scanner `packet_receiver_task` (src/tasks.c:227).
- Grab-bag by design: "tasks that don't belong to a bigger module."

### structs.h / screen.h / packet.h / protocol.h — the data model
- `device_t` (all runtime state), `config_t` (persisted config,
  src/include/structs.h:68-87), `output_t` + `border_size_t` (per-PC screen
  config, src/include/screen.h:40-51, 27-31), `mouse_report_t`
  (src/include/structs.h:34-41), packet types (src/include/protocol.h:17).

### defaults.c / constants.c / user_config.h — configuration data
- Compile-time defaults for speeds, borders, OS per output, hotkey choice
  (src/defaults.c:14-64). `user_config.h` is the "edit me" file.

### utils.c — checksums, flash, packet helpers
- CRC32/checksum (src/utils.c:18-54), config load/save/wipe to the last 4 KB
  of flash (src/utils.c:56-116), flash page writes for firmware upgrades
  (src/utils.c:62), UART packet scanning helpers (src/utils.c:156-187),
  debug printf over CDC (src/utils.c:251, debug builds).
- Depended on by nearly everyone; depends only on the data model.

---

## Input side (core 1 — USB host, reading your real devices)

### usb.c — TinyUSB callback hub (both roles in one file!)
- **Host half** (core 1): device mount/unmount (src/usb.c:122-209), the
  central per-report dispatcher `tuh_hid_report_received_cb`
  (src/usb.c:212-270) routing to keyboard/mouse processors.
- **Device half** (core 0): `tud_*` callbacks — LED set-report from the PC,
  config-mode vendor messages, CDC debug RX (src/usb.c:24-120).
- Surprising: one file serves both directions; the name tells you nothing
  about which core runs what. The `tuh_`/`tud_` prefixes are the real signal
  (TinyUSB host / TinyUSB device).

### hid_parser.c — HID descriptor parser (mount time only)
- Parses a device's HID report descriptor into `hid_interface_t`: where each
  value (x, y, buttons, keys...) lives — bit offset, size, report ID
  (src/hid_parser.c:172).
- Called only from `tuh_hid_mount_cb` (src/usb.c:145). Pure input-schema
  discovery; think "generated TypeScript types, computed at plug-in time."

### hid_report.c — report-value plumbing
- `get_report_value`: extract an arbitrary bit-field from a raw report using
  parsed layout (src/hid_report.c:15).
- Builds the per-report-ID handler routing table used by usb.c's dispatcher
  (mouse/keyboard/consumer/system entries, src/hid_report.c:163-243).
- Keyboard-report extraction for boot/NKRO/other layouts
  (src/hid_report.c:261-341).

### keyboard.c — keyboard pipeline + hotkey engine
- The hotkey table (combo → action handler, src/keyboard.c:18-109) and
  matcher (src/keyboard.c:116-156).
- Merges multiple keyboards' states (local devices + the remote board's
  keyboard) into one combined report (src/keyboard.c:201-217).
- `process_keyboard_report` (src/keyboard.c:294): hotkey check → forward
  locally or via UART. Queue drain task `process_kbd_queue_task`
  (src/keyboard.c:219).
- Depends on handlers.c (action handler function pointers) — and handlers.c
  depends back on keyboard.c (`release_all_keys`, src/handlers.c:393).
  **Circular pair #1.**

### mouse.c — virtual cursor & screen switching
- Fully traced in notes/critical-path.md. Public surface:
  `process_mouse_report` (input side), `queue_mouse_report` +
  `process_mouse_queue_task` (output side), `output_mouse_report` used by
  screensaver in tasks.c.
- Depends on handlers.c (`set_active_output`, src/mouse.c:200) and uart.c
  (`queue_packet`); handlers.c depends back (`queue_mouse_report`,
  src/handlers.c:181). **Circular pair #2.**

---

## Output side (core 0 — USB device, talking to the PCs)

### usb_descriptors.c — what the PC thinks we are
- Descriptors: keyboard + **absolute mouse** + consumer + system on one HID
  interface (src/usb_descriptors.c:41-45); separate **relative mouse**
  ("DeskHop Helper") interface (src/usb_descriptors.c:47); vendor config
  interface; MSC disk; optional CDC debug.
- `tud_mouse_report` picks absolute vs relative interface per report
  (src/usb_descriptors.c:70-81).

### led.c — feedback
- Keyboard LED mirroring per output (desired vs actual, reconciled by
  `led_sync_task`, src/led.c:59) and onboard LED blinking (src/led.c:69).

---

## Inter-board link (UART, both cores)

### uart.c — framing & dispatch
- 12-byte fixed packets `[START1|START2|type|8 data|checksum]`
  (src/uart.c:20-27), TX queue drain via DMA (src/uart.c:44-55), and the
  message-type → handler dispatch table (src/uart.c:61-92).

### setup.c — boot-time wiring
- `initial_setup` (src/setup.c:210): UART + DMA ring buffers
  (src/setup.c:134-208), PIO-USB config, config load, core 1 launch.
- `board_autoprobe` (src/setup.c:77-105): decides if this board is A or B by
  probing whether the UART level-shifter IC drives a pin — no config needed,
  same firmware both sides.
- `is_config_mode_active` (src/setup.c:112): config mode survives reboot via
  magic words in watchdog scratch registers.

### handlers.c — the "controller" layer
- All UART message handlers (mouse/keyboard/output-select/border-sync/config/
  firmware, src/handlers.c:163-379) and all hotkey action handlers
  (src/handlers.c:19-161). Also `set_active_output` (src/handlers.c:386).
- Depends on: keyboard.c, mouse.c, led.c, uart.c, utils.c — and they depend
  back on it. It's the hub of both circular pairs; in web terms it's the
  routes/controllers file.

---

## Config/management plane

### protocol.c — config API as memory pokes
- A table mapping API index → `offsetof(device_t, field)` with type/len and
  read-only flag (src/protocol.c:14-69). The webconfig page reads/writes
  device state by index over the vendor HID interface; SET_VAL literally
  memcpys into `global_state` at that offset. Surprising but compact — the
  webconfig UI and UART protocol share this single schema.
- `PROXY_PACKET_MSG` lets board A relay config reads/writes to board B
  (src/handlers.c:270), so one USB connection configures both boards.

### ramdisk.c — the fake USB drive
- TinyUSB MSC callbacks serving the 64 KB FAT image embedded in flash
  (src/ramdisk.c:39-54); on write of a firmware file, streams it into the
  staging flash area (src/ramdisk.c:61-108, unverified detail level).

---

## Dependency picture

```
                 keyboard.c ◄──────┐
                    │  ▲           │ (action handler fn ptrs)
     usb.c ──► hid_report.c        │
      │             │           handlers.c ◄──► uart.c ──► [other board]
      │        hid_parser.c        │  ▲
      ▼             │              ▼  │ (set_active_output /
   mouse.c ◄────────┘           mouse.c    queue_mouse_report)
      │
      ▼
 usb_descriptors.c ──► PC
```

- Circular: keyboard.c ↔ handlers.c, mouse.c ↔ handlers.c. Harmless in C
  (headers declare everything up front) but means you can't reason about
  these three in isolation.
- protocol.c → device_t layout via `offsetof`: renaming/reordering fields in
  `device_t` or `config_t` silently changes the config API and the on-flash
  config format (there is a `magic_header`/version check,
  src/include/structs.h:69-70, src/defaults.c:15-16).
```
