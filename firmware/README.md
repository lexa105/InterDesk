
# BKMD firmware

Firmware is running on esp32s3 as it has both BLE and USB HID capability and its managed with platformio.

In platformio config file there is currently setup for generic esp32s3 mini dev board and esp32s3 lilygo dongle - ideal as it has male USB-A.

**for tft display to work on esp dongle target correct User_setup.h needs to be used in tft_espi lib**
replace
```
.pio/libdeps/lilygo-t-dongle-s3/TFT_eSPI/User_Setup.h
```
with `User_setup.h` in this folder, after platformio downloads libraries



## Versions

- BKMD_Firmware - main working dir
- AirdropOnly - WIP testing for 

