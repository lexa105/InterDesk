# BKMD File Transfer

A small Electron client for sending files to the BKMD ESP32-S3 over HTTP. The
app intentionally contains no Bluetooth/HID functionality on this test branch.

## Device workflow

1. Flash `firmware/AirdropOnly_firmware` and insert a FAT32-formatted SD card.
2. The device boots in read-only USB Storage mode and exposes `BKMD Storage`.
3. Join the `ESP32_IMG` Wi-Fi network with password `12345678`.
4. Long-press GPIO 0 for at least 750 ms. The USB disk disappears and HTTP
   Transfer mode becomes active.
5. Open the app, connect to `http://192.168.4.1`, choose a file up to 10 MiB,
   and send it.
6. Long-press GPIO 0 again after all transfers finish. The USB disk remounts
   and the received file is available under the `upl` directory.

The USB host and firmware never intentionally access the FAT32 filesystem at
the same time. USB writes are rejected; create or replace files through HTTP.

## Development

```sh
npm install
npm run dev
```

Validation commands:

```sh
npm run lint
npm run build
```

Distribution targets are available through `npm run dist:mac`,
`npm run dist:win`, and `npm run dist:linux`.

## Firmware HTTP API

- `GET /status` is available in every mode.
- `POST /upload_raw?name=FILE` accepts an `application/octet-stream` body in
  HTTP Transfer mode.
- `GET /list` returns received file names and sizes in HTTP Transfer mode.
- `GET /download?name=FILE` downloads a stored file in HTTP Transfer mode.

All API errors are JSON. The upload limit is 10 MiB and only one upload may be
active at a time.
