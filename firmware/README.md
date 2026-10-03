# InterDesk firmware

ESP32-S3 Arduino firmware using NimBLE and native USB HID, built with PlatformIO.

```sh
cd InterDesk_firmware
pio run                                      # build both supported environments
pio run -e lilygo-t-dongle-s3 -t upload        # only after checking your board/wiring
pio device monitor -b 115200
./test/host/run.sh                            # BLE policy tests, no hardware needed
```

Targets: `esp32-s3-devkitc-1` (4 MB flash, no display) and
`lilygo-t-dongle-s3` (16 MB flash, TFT). Platform and NimBLE versions are pinned.
Both targets explicitly select TinyUSB for USB HID.

The display target includes the tracked `../User_Setup.h` automatically; do not
replace files inside `.pio/libdeps`. **Check the GPIO assignments for your board**:
the original setup uses pins 10–14, which differ from the official LilyGO wiring.
They are preserved pending confirmation of the actual dongle variant.

The button on GPIO0 opens pairing after a two-second hold and release. Enter the
six-digit code from the TFT (or serial console on the generic board) in the laptop's
Bluetooth pairing dialog. An eight-second hold and release clears stored bonds.
Pairing expires after 60 seconds. Trusted laptops reconnect using stored bonds.

Firmware and app must be upgraded together to protocol v2. Unencrypted input,
legacy Bluetooth pairing and unauthenticated pairing are rejected. The old
advertising-only “AirDrop” button action has been replaced with pairing controls.
See [protocol, security and hardware verification](../docs/input-and-ble.md).
