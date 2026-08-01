# BKMD AirDrop-only firmware test

This PlatformIO project tests HTTP file transfer to an ESP32-S3 SD card and
read-only exposure of the same FAT32 card as USB mass storage. It is not an
implementation of Apple's AirDrop protocol.

## Hardware and modes

- Target: custom ESP32-S3 board (`lilygo-t-dongle-s3` is retained as the legacy
  PlatformIO environment name).
- SD SPI pins: MISO 16, MOSI 18, SCK 17, CS 47.
- SD SPI frequency: 4 MHz.
- Mode button: GPIO 0, long press for at least 750 ms.
- SD format: FAT32; firmware does not format the card automatically.

The firmware boots in **USB Storage** mode. The computer can read the SD card
through USB MSC, but USB writes are rejected. Long-press GPIO 0 to hide USB
storage and enter **HTTP Transfer** mode. Long-press again, while no upload is
active, to flush storage and re-present it over USB.

## Network and API

- SSID: `ESP32_IMG`
- Password: `12345678`
- Base URL: `http://192.168.4.1`
- Maximum upload: 10 MiB

Endpoints:

- `GET /status`
- `POST /upload_raw?name=FILE` with `Content-Type: application/octet-stream`
- `GET /list`
- `GET /download?name=FILE`

Only `/status` is available in USB Storage mode. Other storage endpoints return
HTTP 409 until the button switches the device to HTTP Transfer mode.

## Build

```sh
pio run -d firmware/AirdropOnly_firmware -e lilygo-t-dongle-s3
```

Append `-t upload` to flash. Serial diagnostics use 115200 baud.

## Standalone SD-card test

The `sd-card-test` environment builds only `src/sd_card_test.cpp`. It uses the
Arduino `SD` and `SPI` libraries with MISO 16, MOSI 18, SCK 17, and CS 47. It
starts at a conservative 4 MHz, mounts the card, lists the root directory, and
verifies write, read, and delete operations using the temporary file
`/bkmd_sd_test.txt`.

Select it in the PlatformIO environment picker, pass `-e sd-card-test` on the
command line, or temporarily change `default_envs` at the top of
`platformio.ini` from `lilygo-t-dongle-s3` to `sd-card-test`.

Build and upload the diagnostic firmware:

```sh
pio run -e sd-card-test -t upload
pio device monitor -b 115200
```

The diagnostic waits until a USB serial monitor connects, so its one-shot boot
messages are not lost while the port re-enumerates after upload. If PlatformIO
cannot select the new port automatically, find it with `pio device list` and
pass it explicitly using `pio device monitor --port PORT -b 115200`. A working
card ends with:

```text
RESULT: PASS - mount, write, read, and delete succeeded
```

To return to the HTTP/USB firmware, upload the normal environment:

```sh
pio run -e lilygo-t-dongle-s3 -t upload
```
