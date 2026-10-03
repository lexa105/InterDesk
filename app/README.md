# InterDesk desktop app

Electron, React and TypeScript frontend for the InterDesk USB HID dongle.
Use Node **22.15+** for development and tests.

```sh
npm ci
npm run dev
```

`npm run dev` starts Vite on port 5123 and Electron. Bluetooth and global input
capture run in Electron, so opening Vite alone does not provide a functioning
Electron bridge. macOS requires permission to observe global input.

```sh
npm run check                # lint, Electron/preload type-check, tests, renderer build
npm run transpile:electron   # main and sandboxed preload builds only
npm run dist:mac
npm run dist:win
npm run dist:linux
```

The Linux UI can be built, but secure dongle connections are unavailable with the
current Noble Linux HCI driver. Native macOS and Windows drivers are used for
passkey pairing. These flows still require real-device verification.

Update the firmware together with the app. Hold the dongle button for two seconds,
release, then scan/connect and enter the displayed code in the OS pairing dialog.
See [pairing, protocol and input behavior](../docs/input-and-ble.md).

Linux packaging rebuilds native dependencies and requires system development
headers, including `libudev-dev` for the `usb` dependency. A renderer build alone
does not verify native packaging prerequisites.
