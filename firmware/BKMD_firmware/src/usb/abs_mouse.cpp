/*
  abs_mouse.cpp

  See abs_mouse.h. Custom report descriptor because arduino-esp32 2.0.17 has no
  absolute-mouse HID class of its own.
*/
#include "USBHID.h"

#if CONFIG_TINYUSB_HID_ENABLED

#include "abs_mouse.h"
#include <string.h>

static const uint8_t report_descriptor[] = {
  HID_USAGE_PAGE(HID_USAGE_PAGE_DESKTOP),
  HID_USAGE(HID_USAGE_DESKTOP_MOUSE),
  HID_COLLECTION(HID_COLLECTION_APPLICATION),
    HID_REPORT_ID(USB_ABS_MOUSE_REPORT_ID)
    HID_USAGE(HID_USAGE_DESKTOP_POINTER),
    HID_COLLECTION(HID_COLLECTION_PHYSICAL),
      /* Left, Right, Middle buttons */
      HID_USAGE_PAGE(HID_USAGE_PAGE_BUTTON),
        HID_USAGE_MIN(1),
        HID_USAGE_MAX(3),
        HID_LOGICAL_MIN(0),
        HID_LOGICAL_MAX(1),
        HID_REPORT_COUNT(3),
        HID_REPORT_SIZE(1),
        HID_INPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),
      /* 5 bit padding */
        HID_REPORT_COUNT(1),
        HID_REPORT_SIZE(5),
        HID_INPUT(HID_CONSTANT),
      HID_USAGE_PAGE(HID_USAGE_PAGE_DESKTOP),
      /* Absolute X, Y position [0, 32767] */
        HID_USAGE(HID_USAGE_DESKTOP_X),
        HID_USAGE(HID_USAGE_DESKTOP_Y),
        HID_LOGICAL_MIN_N(0x0000, 2),
        HID_LOGICAL_MAX_N(0x7FFF, 2),
        HID_REPORT_COUNT(2),
        HID_REPORT_SIZE(16),
        HID_INPUT(HID_DATA | HID_VARIABLE | HID_ABSOLUTE),
      /* Relative vertical wheel [-127, 127] */
        HID_USAGE(HID_USAGE_DESKTOP_WHEEL),
        HID_LOGICAL_MIN(0x81),
        HID_LOGICAL_MAX(0x7F),
        HID_REPORT_COUNT(1),
        HID_REPORT_SIZE(8),
        HID_INPUT(HID_DATA | HID_VARIABLE | HID_RELATIVE),
    HID_COLLECTION_END,
  HID_COLLECTION_END
};

typedef struct __attribute__((packed)) {
  uint8_t buttons;
  uint16_t x;
  uint16_t y;
  int8_t wheel;
} abs_mouse_report_t;

USBHIDAbsMouse::USBHIDAbsMouse() : hid(), _buttons(0), _x(0), _y(0) {
  static bool initialized = false;
  if (!initialized) {
    initialized = true;
    hid.addDevice(this, sizeof(report_descriptor));
  }
}

uint16_t USBHIDAbsMouse::_onGetDescriptor(uint8_t* dst) {
  memcpy(dst, report_descriptor, sizeof(report_descriptor));
  return sizeof(report_descriptor);
}

void USBHIDAbsMouse::begin() {
  hid.begin();
}

void USBHIDAbsMouse::end() {
}

bool USBHIDAbsMouse::sendReport(uint8_t buttons, uint16_t x, uint16_t y, int8_t wheel) {
  if (x > ABS_MOUSE_MAX) x = ABS_MOUSE_MAX;
  if (y > ABS_MOUSE_MAX) y = ABS_MOUSE_MAX;

  _buttons = buttons & ABS_MOUSE_ALL;
  _x = x;
  _y = y;

  // The wire format is little-endian and so is the ESP32-S3, so the packed
  // struct can go out as-is.
  abs_mouse_report_t report = {
    .buttons = _buttons,
    .x = _x,
    .y = _y,
    .wheel = wheel
  };
  return hid.SendReport(USB_ABS_MOUSE_REPORT_ID, &report, sizeof(report));
}

bool USBHIDAbsMouse::releaseAll() {
  if (_buttons == 0) {
    return true;
  }
  return sendReport(0, _x, _y, 0);
}

#endif /* CONFIG_TINYUSB_HID_ENABLED */
