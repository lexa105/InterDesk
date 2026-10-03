#pragma once

// Tracked TFT_eSPI setup, included by PlatformIO with USER_SETUP_LOADED.
// These are the original project's effective GPIO assignments. They are NOT
// the standard LilyGO T-Dongle-S3 pins; confirm the actual board before rewiring.
#define USER_SETUP_INFO "InterDesk existing dongle wiring"
#define ST7735_DRIVER
#define TFT_RGB_ORDER TFT_BGR
#define TFT_WIDTH 80
#define TFT_HEIGHT 160
#define ST7735_GREENTAB160x80
#define TFT_INVERSION_ON

#define TFT_MOSI 11
#define TFT_SCLK 10
#define TFT_CS 12
#define TFT_DC 13
#define TFT_RST 14

#define LOAD_GLCD
#define LOAD_FONT2
#define LOAD_FONT4
#define LOAD_FONT6
#define LOAD_FONT7
#define LOAD_FONT8
#define LOAD_GFXFF
#define SMOOTH_FONT

#define SPI_FREQUENCY 40000000
#define SPI_READ_FREQUENCY 20000000
#define SPI_TOUCH_FREQUENCY 2500000
#define USE_HSPI_PORT
