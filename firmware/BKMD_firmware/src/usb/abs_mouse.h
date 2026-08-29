/*
  abs_mouse.h

  Absolute-positioning USB HID pointer for the BKMD dongle.

  The arduino-esp32 core installed for this project (framework-arduinoespressif32
  3.20017 == arduino-esp32 2.0.17) does not ship USBHIDAbsoluteMouse, so this is a
  minimal USBHIDDevice implementation following the same pattern as the core's
  USBHIDMouse.

  It enumerates as a second HID report (report ID USB_ABS_MOUSE_REPORT_ID) next to
  the existing relative USBHIDMouse, so both pointer modes stay available at once.

  Report layout (6 bytes, matching the 6-byte BLE payload):
    [0] buttons bitmask (bit0 left, bit1 right, bit2 middle)
    [1..2] x, uint16 little-endian, 0..32767
    [3..4] y, uint16 little-endian, 0..32767
    [5] wheel, int8 (relative)
*/

#pragma once
#include "USBHID.h"
#if CONFIG_TINYUSB_HID_ENABLED

#include <stdint.h>

// Report IDs 0..6 are taken by the core's enum in USBHID.h (NONE..VENDOR).
#define USB_ABS_MOUSE_REPORT_ID 7

#define ABS_MOUSE_LEFT   0x01
#define ABS_MOUSE_RIGHT  0x02
#define ABS_MOUSE_MIDDLE 0x04
#define ABS_MOUSE_ALL    0x07

// Logical maximum of the X/Y axes; the host maps 0..ABS_MOUSE_MAX to the full screen.
#define ABS_MOUSE_MAX 32767

class USBHIDAbsMouse : public USBHIDDevice {
private:
  USBHID hid;
  uint8_t _buttons;
  uint16_t _x;
  uint16_t _y;

public:
  USBHIDAbsMouse(void);
  void begin(void);
  void end(void);

  // Sends one absolute report. x/y are clamped to 0..ABS_MOUSE_MAX.
  bool sendReport(uint8_t buttons, uint16_t x, uint16_t y, int8_t wheel = 0);

  // Releases every button, keeping the last reported position.
  bool releaseAll(void);

  uint8_t buttons(void) const { return _buttons; }
  uint16_t x(void) const { return _x; }
  uint16_t y(void) const { return _y; }

  // internal use
  uint16_t _onGetDescriptor(uint8_t* buffer);
};

#endif /* CONFIG_TINYUSB_HID_ENABLED */
