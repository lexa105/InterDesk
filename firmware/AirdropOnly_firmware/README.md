# BKMD AirDrop-only firmware test

This PlatformIO project tests HTTP file transfer to an ESP32-S3 SD card and
read-only exposure of the same FAT32 card as USB mass storage. It is not an
implementation of Apple's AirDrop protocol.

## Hardware and modes

- Target: ESP32-S3 / LilyGO T-Dongle-S3 configuration.
- SD-MMC pins: CLK 36, CMD 35, D0 37, D1 38, D2 33, D3 34.
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
