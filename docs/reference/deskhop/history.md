# Archaeology: Why the Code Looks the Way It Does

158 commits, 2023-12-24 → 2026-06-27. Written by the maintainer (hrvach) plus a
steady stream of community PRs. History method: `git log --name-only` for churn,
`git log -S` (pickaxe) to date specific code, commit messages for motive.

## The three eras

1. **Viral launch (Dec 2023 – Mar 2024)** — initial commit c10f971 lands
   2023-12-24; the project trends and features pour in fast: screensavers,
   config hotkeys, mouse acceleration, Windows workaround. Notably, the SDK gets
   *bundled into the repo* because users couldn't build it
   (09935f5: "after several reports, bundling pico-sdk and tinyusb to
   simplify building").
2. **The big rewrite — v0.61 (Jul 2024, 1415c1d)** — 153 files,
   +8,348/−12,660. This is where today's architecture appears in one commit:
   **"Single unified firmware binary"** (before this, boards A and B ran
   *different* binaries!), the full HID descriptor parser (hid_parser.c), the
   webconfig HTML + `protocol.c` field-map API, the embedded FAT ramdisk, and
   report-protocol keyboards by default. Most of what Phase 3 mapped simply
   did not exist before this commit.
3. **Hardening & community era (Nov 2024 – Jun 2026)** — bursts of activity
   (14 commits 2024-11, 16 in 2025-01, 11 in 2026-01/06) almost entirely
   driven by *compatibility fixes*: specific keyboards, specific OS behaviors,
   specific USB hubs. HEAD today is "Fix ramdisk mount bug" (59577cc).

## The 5 most-churned files, and why

| File | Commits | Root cause of churn |
|---|---|---|
| src/mouse.c | 35 | OS quirks, mostly macOS virtual desktops |
| src/handlers.c | 24 | Accretion point: every feature adds a hotkey + a UART message handler |
| src/keyboard.c | 23 | Real keyboards are weird; multi-keyboard support saga |
| src/usb.c | 20 | Device slotting/dispatch grew with multi-device support |
| src/usb_descriptors.c + src/hid_report.c | 17 each | Interface-numbering collisions; HID-spec edge cases |

### mouse.c — the macOS saga (the single gnarliest thread)

The core coordinate math has barely changed since 2024. The churn is almost
all *workarounds for what OSes do with absolute pointer reports*:

- 3198ed7 (2024-11) "fix transition between screens of different sizes on
  macos" — first appearance of the edge-park trick.
- ff70bda + 9939903 (2024-11-27) "Tweak macos screen switch helper" — the
  relative-nudge loop is born (`MACOS_SWITCH_MOVE_COUNT`, mouse.c:233:
  "Once doesn't seem reliable enough, do it a few times").
- a91d450 / 1e03df3 (2025) "Fix dragging windows across macos virtual
  desktops" — buttons must be zeroed in the nudge reports or a drag sticks
  forever (the comment at mouse.c:224-227).
- 58664dd (2026-05) + 9d161be (2026-06, PR #342) "Fix mouse movement
  threshold and stuck drag during virtual desktop switches" — jump_threshold
  became per-direction/per-screen (`get_jump_threshold`, mouse.c:19-32).
- af4d38c (2026-05, PR #341) "Fix spontaneous mouse jumps from composite
  keyboards" — QMK keyboards exposing a mouse interface sent zero-movement
  reports that re-asserted stale absolute positions; hence the all-zeros
  early-return guard (mouse.c:355-363).

Lesson encoded in this file: **the absolute-coordinate model is clean; the
mess is 100% at the OS boundary.** Anyone building a similar system should
budget their time the same way.

### hid_report.c / hid_parser.c — the HID-spec-vs-reality war

- 0ae26eb (2025-02): "Fix non-aligned nkro bit array parsing" — NKRO
  keyboards pack keys as a bitmap that need not be byte-aligned
  (extract_bit_variable, hid_report.c:245).
- 6c92c11 (2025-10): "Track HID report offsets per report ID per USB spec" —
  the parser tracked one running bit-offset per interface; the spec says
  offsets restart per report ID. Wrong for over a year before a device
  surfaced it (get_or_create_report_offset, hid_parser.c:36).
- 5f359b7 (2026-05): "fall back to boot extractor when NKRO extraction
  fails" — some wireless keyboards lie about their NKRO layout.
- 4d657bd (2026): MS Ergonomic keyboard-specific fix (PR #307).

### keyboard.c / usb.c — the multi-keyboard saga

- 727007f (2025-05) "Enables support for multiple keyboard devices", then
  fixes abe0795, 0b26a50 — this is where `local_kbd_states[MAX_DEVICES]`,
  state-merging (combine_kbd_states, keyboard.c:201) and usb.c's
  device-index slotting scheme (usb.c:220-246) come from. The long comment
  there is fossilized history: slot 0 = primary keyboard, 1 = mice,
  MAX_DEVICES-2 = secondary keyboards, MAX_DEVICES-1 reserved for the
  remote board.
- 6db0fb8 (2025): MAX_DEVICES increased for USB hubs, "+23KB RAM
  (107KB → 130KB), but we still have 130KB free" — RAM is spent freely for
  compatibility because the program is small.

### usb_descriptors.c — interface-numbering whack-a-mole

USB interfaces are identified by index, and DeskHop has three different
lineups (normal / config mode / debug build). Collisions caused subtle bugs
fixed in 3625c08 ("update interface numbers so that they don't collide in
config mode; fixes desktop transitions on macos when in config mode") and
6c6b537 (2026, CDC interface numbers in debug builds). Also efcefcc: VID/PID
swapped to a standard pid.codes ID by user request.

## Honest-mistake exhibit

27c981a (2025-02): firmware version/checksum was mis-parsed for months
because the Python build helper packed a u32 as 16-bit — commit message:
"Welp, this is embarassing... ->> Might require manual fw upgrade <<-".
Worth remembering: the CRC/versioning toolchain (misc/crc32.py + linker
sections) is hand-rolled and has bitten before.

## Takeaways for a newcomer

1. Churn concentrates at the **OS boundary** (mouse.c workarounds) and the
   **device boundary** (HID parsing) — not in the core model. Expect any
   change you make to be safe in the middle and risky at the edges.
2. `handlers.c` grows monotonically; new features = new message type + new
   handler + often a new hotkey. Follow that pattern when extending.
3. Much of the polish arrived via external PRs fixing one specific device or
   OS combo. Before "fixing" odd-looking code (the nudge loop, the NKRO
   fallback, the zero-report guard), check `git log -S` — it's probably a
   deliberate workaround with a linked issue.
