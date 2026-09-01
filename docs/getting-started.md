# Getting Started (Electron App)

This guide covers how to install and run the InterDesk desktop app (the `app/` directory) on your laptop
(PC1 — the machine you'll type on).

## 1. Install Node.js

You need Node.js 18 or newer (includes `npm`).

- Download from [nodejs.org](https://nodejs.org/) (LTS version recommended), **or**
- Install via a version manager like [nvm](https://github.com/nvm-sh/nvm):
  ```bash
  nvm install --lts
  nvm use --lts
  ```

Check it worked:
```bash
node -v
npm -v
```

## 2. Get the code

```bash
git clone <repo-url>
cd InterDesk/app
```

## 3. Install dependencies

```bash
npm install
```

This also pulls in native modules (`uiohook-napi` for keyboard capture, `@stoprocent/noble` for
Bluetooth) which may take a little longer to install than a typical `npm install`.

## 4. Run the app in development mode

```bash
npm run dev
```

This starts the React UI (Vite) and the Electron shell together. The app window should open
automatically.

## 5. macOS permissions (first run)

If you're on macOS, you'll likely be prompted to grant:
- **Accessibility** access — required for global keyboard capture (`uiohook-napi`).
- **Bluetooth** access — required to scan/connect to the dongle.

Grant both in **System Settings → Privacy & Security**, then restart the app if it doesn't pick
up the permissions automatically.

## Other commands

```bash
npm run build       # type-check + production build
npm run dist:mac     # package a macOS .dmg/.app
npm run dist:win      # package for Windows
npm run dist:linux    # package for Linux
npm run lint
```

## Troubleshooting

- **App doesn't see the dongle**: make sure the dongle is powered on and advertising, and that
  Bluetooth is enabled on your laptop.
- **Keystrokes aren't being captured**: double-check the Accessibility permission above, then
  restart the app.
- **`npm install` fails on native modules**: make sure you have the standard build tools for your
  OS installed (Xcode Command Line Tools on macOS, `build-essential` on Linux, or the "Desktop
  development with C++" workload via Visual Studio Build Tools on Windows).
