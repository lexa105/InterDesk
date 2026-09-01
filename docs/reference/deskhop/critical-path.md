# Critical Path: One Mouse Movement, End to End

**Chosen operation:** a physical mouse movement arriving over USB, being converted
to an absolute on-screen position, and — when it hits a screen border — switching
output to the other computer.

**Why this one:** it is the product's entire purpose. Every user interaction flows
through this path, and it exercises all three I/O subsystems (USB host in, USB
device out, inter-board UART link). It is also exactly the problem the reader is
solving (cursor transformation between two computers).

---

## The coordinate model (read this first)

- DeskHop keeps its **own virtual cursor**: `state->pointer_x` / `pointer_y`
  (src/include/structs.h:108-109), integers in a fixed virtual space
  **0..32767 on both axes** (`MIN_SCREEN_COORD`/`MAX_SCREEN_COORD`,
  src/include/screen.h:20-21). Real pixel resolutions never appear anywhere.
- Each computer sees the mouse as an **absolute pointing device** whose HID
  descriptor declares logical range 0..0x7FFF (src/include/usb_descriptors.h:71,
  101). The OS maps 0..32767 onto the full screen itself — so the same report
  works for any resolution, any OS, with no drift.
- Physical mice still send **relative deltas**; DeskHop accumulates them into the
  virtual position (src/mouse.c:139-140).
- Per-output config lives in `output_t` (src/include/structs.h in `config_t`,
  see src/include/screen.h:40-51): `speed_x/y`, `border` (top/bottom), `os`,
  `pos` (which side the other PC is on), `screen_count`/`screen_index`
  (virtual desktops), `mouse_park_pos`.
- Defaults: border = {0, 32767}, one screen per output, A is on the RIGHT of B
  (src/defaults.c:22-29, 42-49).

## Hardware/topology reminder

Two identical boards, one per computer, linked by UART. Each board:
- **PIO-USB host port** (core 1): where the real keyboard/mouse plug in.
- **Native USB device port** (core 0): pretends to be keyboard+mouse to its PC.
Whichever board owns the physical mouse runs steps 1–5; if the *other* PC is the
active output, the report travels over UART (steps 6b/7).

---

## Step-by-step trace

### 1. USB interrupt transfer arrives (core 1)
- `usb_host_task` polls TinyUSB host (src/main.c:53).
- TinyUSB fires the callback `tuh_hid_report_received_cb`
  (src/usb.c:212). It classifies the interface (keyboard/mouse/other,
  src/usb.c:230-246) and dispatches:
  - Boot-protocol mouse → `process_mouse_report` directly (src/usb.c:265).
  - Report-ID devices → per-report-ID handler table (src/usb.c:248-259),
    whose mouse entries also point at `process_mouse_report`
    (src/hid_report.c:168-200). Those handlers were wired up at device mount
    time by parsing the device's HID report descriptor (src/hid_parser.c).
- Re-arms the next report request (src/usb.c:269).

### 2. Extract values from the raw report
- `process_mouse_report` (src/mouse.c:348) → `extract_report_values`
  (src/mouse.c:303): boot protocol is a fixed struct cast (src/mouse.c:305-314);
  otherwise each field (x, y, wheel, pan, buttons) is pulled from arbitrary bit
  offsets using the parsed descriptor layout (src/mouse.c:318-325).
- Zero-change reports are dropped (guards against QMK composite keyboards
  emitting spurious mouse reports, src/mouse.c:355-363).

### 3. Update the virtual cursor — `update_mouse_position` (src/mouse.c:122)
- Optional acceleration: 7-point curve with linear interpolation on the 2D
  magnitude (src/mouse.c:70-119).
- Speed scaling: `offset = round(delta * accel * speed_x)` per output
  (src/mouse.c:131-133); "mouse zoom" mode right-shifts speed to slow down
  (src/mouse.c:127-128).
- **Border check** *before* moving: `is_screen_switch_needed` (src/mouse.c:35)
  returns LEFT/RIGHT/NONE if `position + offset` would leave 0..32767. A
  configurable `jump_threshold` (src/defaults.c:63) demands extra "push" past
  the edge before a cross-PC jump; local virtual-desktop switches need none
  (`get_jump_threshold`, src/mouse.c:19-32).
- Position updated and clamped to the screen (`move_and_keep_on_screen`,
  src/mouse.c:55-66, applied at 139-140). Buttons saved (src/mouse.c:143).

### 4. Build the outgoing HID report — `create_mouse_report` (src/mouse.c:328)
- Normally: **absolute** report carrying `pointer_x/y` (src/mouse.c:329-336).
- Exception: gaming mode or Windows-extra-desktop mode sends raw **relative**
  deltas instead (src/mouse.c:339-343).

### 5. Route the report — `output_mouse_report` (src/mouse.c:149)
- If *this* board's PC is the active output → local queue
  (`queue_mouse_report`, src/mouse.c:411-417).
- Else → serialize onto the UART link: `queue_packet(..., MOUSE_REPORT_MSG, ...)`
  (src/mouse.c:154).

### 6a. Local delivery (core 0)
- `process_mouse_queue_task` runs at 2 kHz (src/main.c:30; src/mouse.c:383):
  peeks the queue, wakes a suspended host if needed (src/mouse.c:395-396), sends
  via `tud_mouse_report` (src/usb_descriptors.c:70-81) — absolute reports go to
  the combined kbd+abs-mouse interface, relative ones to a separate
  "DeskHop Helper" relative-mouse interface (src/usb_descriptors.c:41-47, 75-78).
  Dequeues only on successful send (src/mouse.c:403-408).

### 6b. Remote delivery — UART hop to the twin board
- Sender, core 0: `process_uart_tx_task` (src/main.c:32; src/uart.c:44-55) pops
  the queue, frames a fixed **12-byte packet**: `[START1][START2][type][8 data
  bytes][checksum]` (src/uart.c:20-27), pushes it out via DMA.
- Receiver, core 1 on the other board: `packet_receiver_task` (src/main.c:54;
  src/tasks.c:227-244) scans a DMA ring buffer for the start marker, then
  `process_packet` (src/uart.c:94) verifies the checksum and dispatches through
  the handler table (src/uart.c:61-92).
- `handle_mouse_abs_uart_msg` (src/handlers.c:179-188): queues the report into
  its *local* mouse queue (→ step 6a on that board) and **mirrors
  `pointer_x/y`/buttons into its own state** so both boards agree on where the
  cursor is.

### 7. Border crossing — `do_screen_switch` (src/mouse.c:268)
Runs after the report is sent, when step 3 returned LEFT/RIGHT:
- Refuses if switching is locked or gaming mode (src/mouse.c:272), or if a
  mouse button is held at the PC border (drag protection, src/mouse.c:279).
- Moving *toward* the other PC from the main screen (`screen_index == 1`,
  `output->pos != direction`) → `switch_to_another_pc` (src/mouse.c:282, 189):
  1. Parks the now-idle cursor on the old PC: sends one last absolute report
     with X pinned to the far edge and Y = top/bottom/unchanged per
     `mouse_park_pos` (src/mouse.c:191-199).
  2. `set_active_output` (src/handlers.c:386-394): flips `active_output`,
     updates LEDs, notifies the twin board (`OUTPUT_SELECT_MSG`,
     src/handlers.c:389 → src/handlers.c:191-197 on the other side), and
     releases all held keys so nothing gets stuck (src/handlers.c:393).
  3. Teleports the virtual cursor to the opposite edge of the new screen
     (src/mouse.c:201) and maps Y through `scale_y_coordinate` (below).
- Moving toward/away with multiple monitors configured on one PC →
  `switch_virtual_desktop` (src/mouse.c:237-258) with per-OS tricks:
  macOS needs an edge-park plus a burst of small relative nudges
  (src/mouse.c:205-235); Windows beyond screen 1 flips to relative mode
  (src/mouse.c:243-245); Linux treats everything as one big screen.

### 8. Height calibration — `scale_y_coordinate` (src/mouse.c:159-187)
Handles monitors of different heights so the cursor appears at the same
physical height:
- Each output's `border.top/bottom` describe, in 0..32767 units, where the
  *smaller* monitor's top/bottom edges line up on this output
  (src/include/screen.h:27-31). Defaults are full-range (src/defaults.c:22-25),
  i.e. no correction.
- Same sizes → Y passes through (src/mouse.c:167-168). Otherwise linear map:
  going to the bigger screen `y' = top + size*y/32767` (src/mouse.c:173-174);
  going to the smaller screen `y' = (y - top)*32767/size`, clamped when the
  cursor is outside the mapped band (src/mouse.c:180-186).
- Calibration UX: user parks the cursor level with the smaller screen's edge and
  presses a hotkey; `screen_border_hotkey_handler` stores `pointer_y` as top or
  bottom depending on which half of the screen it's in (src/handlers.c:28-34,
  44-52), saves config, and syncs the values to the twin board
  (`SYNC_BORDERS_MSG`, src/handlers.c:51, 224-235). Values are also settable
  via the webconfig HTML API.

---

## Files touched, in order

| # | File | Role in the path |
|---|------|------------------|
| 1 | src/main.c:53 | core 1 loop schedules `usb_host_task` |
| 2 | src/usb.c:212-270 | TinyUSB host callback, dispatch by protocol/report ID |
| 3 | src/hid_parser.c / src/hid_report.c:168-200 | (mount-time) descriptor parsing that made dispatch possible |
| 4 | src/mouse.c:348-377 | extract → update position → build → route → maybe switch |
| 5 | src/include/screen.h, src/include/structs.h | coordinate space, `output_t`, `mouse_report_t`, `device_t` |
| 6 | src/uart.c:31-55 / src/tasks.c:227-244 | UART framing, DMA TX, ring-buffer RX (remote case) |
| 7 | src/handlers.c:179-197, 386-394 | remote mouse msg, output select, border sync |
| 8 | src/mouse.c:383-417 | core 0 queue drain at 2 kHz |
| 9 | src/usb_descriptors.c:41-81 | absolute/relative HID interfaces, `tud_mouse_report` |
| 10 | src/defaults.c:14-64 | default speeds, borders, threshold |

## Notes for the reader's own project (Electron + ESP32 BLE)

- The transferable core: **normalize to a fixed absolute space (0..32767), have
  the receiving side enumerate as an absolute pointing device, and make edge
  transitions pure coordinate math** (edge flip for X at src/mouse.c:201, linear
  Y remap at src/mouse.c:159-187). No delta mirroring, no drift.
- The Y-border calibration scheme (two user-recorded values per screen pair,
  linear interpolation between them) is simple and OS-independent — directly
  reusable. In an Electron host app it can even be automatic: the OS already
  knows both monitors' geometry.
- The guard details are where the polish lives: jump threshold (src/mouse.c:19),
  no switching mid-drag (src/mouse.c:279), releasing held keys on switch
  (src/handlers.c:391-393), parking the cursor out of the way (src/mouse.c:193),
  and the macOS relative-nudge workaround (src/mouse.c:205-235).
