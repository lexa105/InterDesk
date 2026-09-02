
# InterDesk

**Turn your laptop into a wireless keyboard and mouse for any other computer.**

InterDesk is an open-source hardware + software project in two parts:

- a **cross-platform desktop app** (Electron + React + TypeScript) that runs on the machine you
  type on macOS, Windows or Linux and captures your keyboard and trackpad input;
  (⚠️ Only tested controlling a Windows PC from a macOS laptop, other host/target combinations are untested.)
- a **tiny ESP32-S3 USB dongle** that plugs into the machine you want to control and shows up
  there as an ordinary USB keyboard and mouse.

The app packs your input into standard USB HID reports and sends them over Bluetooth Low Energy
to the dongle, which replays them over USB. The whole trick lives in those two pieces, and that
is what makes the core idea work:

**Nothing is installed on the controlled computer.** No app, no driver, no agent, no account, no
network access, not even an OS that knows what InterDesk is. From its point of view a keyboard
and a mouse were plugged into a USB port. That is why it works on a desktop, a locked-down
school or office PC, a server on a KVM, a machine with no Wi-Fi, an old box running something
ancient, a Raspberry Pi, a smart TV. Anything with a USB port that accepts a keyboard.

Because the sending side is Electron, one codebase covers every desktop OS, and because the
receiving side is generic USB HID, the target OS does not matter at all. The dongle itself costs
under €10 in parts.

## Why?
In a world where there's tech for almost every niche problem, there's always an even more niche problem waiting to be solved!

I often work with my laptop and desktop side by side. The problem is that my laptop ends up sitting right in front of the desktop keyboard, so whenever I need to use the other computer, I have to awkwardly reach around it or keep moving between two sets of peripherals.

InterDesk solves that with a tiny wireless USB dongle. Plug the dongle into the computer you want to control and run the companion app on your laptop. Your laptop’s keyboard and touchpad inputs are sent wirelessly over Bluetooth to the dongle, which forwards them as standard USB HID input — meaning no software is required on the controlled device.

That means it can work with everything from your everyday desktop to locked-down school computers, old machines, or any system where installing additional software isn’t an option.

![InterDesk dongle](img/InterDongle.png)


## Features
- Free desktop switching
- Use your laptop's touchpad and keyboard
- **Wireless** control over Bluetooth
- Powered by an esp32s3 == **<5€ solution**
- **No installation on controlled device**
- Keyboard shortcuts for fast switching





## How does it work?

1. Plug the InterDesk dongle into the computer you want to control.
2. Open the InterDesk app on your laptop and connect to the dongle over Bluetooth.
3. Set up or use the activation shortcut to switch input forwarding on and off.
4. When active, the app captures your keyboard and mouse input and converts it into standard HID reports.
5. These reports are sent over Bluetooth to the dongle.
6. The esp32s3 sends the reports directly to the controlled computer over USB.

The controlled computer sees the dongle as a normal USB keyboard and mouse. No InterDesk software or drivers are needed on it.

![InterDesk connection](img/graph.png)

## Dongle

InterDesk is built around the ESP32-S3 as it gives all we need in small and cheap MCU.

- **Bluetooth Low Energy** to communicate wirelessly with the laptop.
- **Native USB**  so it can act as a USB HID keyboard and mouse.

Our main hardware is **[this dongle](https://www.aliexpress.com/item/1005009024098181.html?spm=a2g0o.detail.0.0.7031xi6bxi6b8k&productId=1005009024098181&pdp_ext_f=%7B%22tabScene%22%3A%22retail%22%2C%22sku_id%22%3A12000047619166787%2C%22origProductId%22%3A%221005009024098181%22%7D#nav-description)** with male USB-A connector for **less then 10euro**. Firmware can also run on other cheaper boards, such as an **ESP32-S3 Zero**, but you need cable. Unfortunatelly we didnt find widely available board with usbc male connector

Firmware for esp32s3 is flashed using platformio. TODO - user_setup.h fix for dongle plaformio target.


## App

The InterDesk desktop app is built with **Electron, React and TypeScript** so the same app can run on macOS, Windows and Linux.

The app uses:

* **`uiohook-napi`** to capture global keyboard and mouse input.
* **`@stoprocent/noble`** to scan for the InterDesk dongle, connect over Bluetooth Low Energy and send HID reports.
* **React + Tailwind CSS** for the user interface.

When input forwarding is active, the app captures keyboard and mouse events, converts them into HID reports and sends them to the dongle over BLE.

![InterDesk demo](img/donge.gif)

### Run the app

```bash
cd app
npm install
npm run dev
```

This starts the React/Vite interface together with Electron in development mode.

### Build

```bash
npm run build
```

Platform-specific packages can also be created with:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## Goals
We have many more ideas we want to implement if the project proves useful to others. For example:

- Add a wireless flash drive mode for fast file transfer
- Make switching between computers easier
- Improve speed and latency
- Design a custom PCB with both USB-A and USB-C connectors and a faster esp32s31
- Clipboard transfer to connected device


This is our first larger project, so we welcome any suggestions or recommendations for improvement.

## ⚠️ Responsible use

Because the dongle looks like an ordinary USB keyboard and mouse, InterDesk works on computers
where you cannot install software or do not have administrator rights — school computers, office
machines, lab PCs, shared workstations. That is the point of the design, and it is also the part
worth thinking about before you plug it in.

- **Being able to plug it in is not the same as being allowed to.** "No installation required"
  means the operating system does not stop you. It does not mean the organisation that owns the
  machine permits it. Most schools and workplaces have acceptable-use or IT policies that cover
  peripherals, wireless devices and remote input.
- **Ask first.** If the computer is not yours — work, school, university, public — talk to
  whoever administrates it before using InterDesk on it. Usually this is a boring conversation,
  and it is a much better one than the alternative.
- **Expect security software to notice.** A device that presents itself as a keyboard and takes
  its input wirelessly looks a lot like the tools endpoint security is built to catch
  (BadUSB / "rubber ducky" style). Some environments block unknown HID devices outright.
- **Never use it on a machine you have no right to control.** Sending input to someone else's
  computer without their knowledge or consent is not something this project supports, and
  depending on where you live it may be illegal.

InterDesk is made as a convenience tool for controlling your own computers. **Any malicious or
unauthorised use is entirely the responsibility of the user.** As the MIT license states, the
software and firmware are provided "as is", without warranty of any kind, and the authors accept
no liability for how they are used.

## Contributing

InterDesk is open source (MIT) and we would love help. It is a small project with a clear
boundary in the middle — the BLE wire format between app and dongle — so you can work on one
side without knowing the other.

Good places to jump in:

- **Desktop app** (`app/`) — TypeScript, Electron, React, Tailwind. Input capture, BLE
  central, UI. Windows and Linux especially need testing: the HID key mapping was written and
  verified on macOS only.
- **Firmware** (`firmware/InterDesk_firmware/`) — C++ / PlatformIO / Arduino / NimBLE on the
  ESP32-S3. USB HID descriptors, BLE server, latency, board support.
- **Hardware** — a custom PCB with both USB-A and USB-C male connectors is on the wish list.
- **Anything else** — bug reports, latency measurements, a board that works better than ours,
  or just telling us the setup broke on your machine are all useful.

If you are changing anything that crosses the BLE boundary (report layout, UUIDs, framing), it
has to change on both sides at once — there is no shared schema between the TypeScript and the
C++. See `CLAUDE.md` for the protocol and the repo layout.

Open an issue before starting something large so we do not duplicate work. This is our first
bigger project, so suggestions about how we build it are as welcome as code.

