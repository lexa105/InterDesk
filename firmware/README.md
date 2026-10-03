# InterDesk firmware

ESP32-S3 Arduino firmware using NimBLE and native USB HID, built with PlatformIO.

```sh
cd InterDesk_firmware
pio run                                      # build all supported environments
pio run -e lilygo-t-dongle-s3 -t upload        # only after checking your board/wiring
pio run -e esp32-s3-headless-16mb -t upload   # 16 MB dongle with no/broken display
pio device monitor -b 115200
./test/host/run.sh                            # BLE policy tests, no hardware needed
```

Targets: `esp32-s3-devkitc-1` (4 MB flash, no display),
`esp32-s3-headless-16mb` (16 MB flash, no display), and
`lilygo-t-dongle-s3` (16 MB flash, TFT). Platform and NimBLE versions are pinned.
All targets explicitly select TinyUSB for USB HID.

The display target includes the tracked `../User_Setup.h` automatically; do not
replace files inside `.pio/libdeps`. **Check the GPIO assignments for your board**:
the original setup uses pins 10–14, which differ from the official LilyGO wiring.
They are preserved pending confirmation of the actual dongle variant.

Open a blank text editor on the USB-connected computer and enable Num Lock.
Hold the GPIO0 button for two seconds and release: the dongle types its six-digit
pairing code as USB keypad digits, without pressing Enter. Enter that code in the
connecting laptop's Bluetooth dialog. No working dongle screen is required.
An eight-second hold and release clears stored bonds and types a fresh code.
Pairing expires after 60 seconds. Trusted laptops reconnect using stored bonds,
without typing anything. Display builds also show the code on the TFT; builds
without a display also print it to the USB serial console at 115200 baud.

Typing is triggered only by the physical button, never by a Bluetooth request.
If USB stalls, the remaining digits are abandoned and releases are retried; focus
the text editor and hold/release the button again for a fresh code.

Firmware and app must be upgraded together to protocol v2. Unencrypted input,
legacy Bluetooth pairing and unauthenticated pairing are rejected. The old
advertising-only “AirDrop” button action has been replaced with pairing controls.
See [protocol, security and hardware verification](../docs/input-and-ble.md).
