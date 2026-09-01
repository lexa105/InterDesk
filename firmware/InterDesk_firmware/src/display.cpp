/* InterDesk TFT status display. */

#include "display.h"

#ifdef HAS_TFT

#include <TFT_eSPI.h> // Hardware-specific library


static TFT_eSPI tft = TFT_eSPI();

#define TERM_GREEN 0x07E0  // čistě zelená (RGB565)
#define TERM_BG    TFT_BLACK
#define TERM_RED   TFT_RED
#define TERM_HISTORY 0x03E0 //tmave zelenaa 

//KEYBOARD MODE
const char* keyboard_history[3] = {"", "", ""};

void Display::display_init() {
    tft.init();
    tft.setRotation(1);
    tft.fillScreen(TERM_BG);
    tft.setTextFont(1); // GLCD 8x8
    tft.setTextColor(TERM_RED, TERM_BG);
    tft.setTextDatum(TL_DATUM); // Zarovnání vlevo nahoře
}

//  stavový text 
void Display::display_show_state(const char* state) {
    tft.fillRect(0, 8, tft.width(), 8, TERM_BG);
    tft.setTextFont(1); // GLCD 8x8
    tft.setTextColor(TERM_GREEN, TERM_BG);
    tft.setTextDatum(TL_DATUM); // Zarovnání vlevo nahoře
    String line = ">";
    line += state;
    tft.drawString(line, 0, 8); // 8 px odshora pro lepší vzhled
}

// Menší běžný text (pod stavem)
void Display::display_show_debug(const char* text) {
    tft.fillRect(0, 40, tft.width(), 8, TERM_BG);
    tft.setTextFont(1); // GLCD 8x8
    tft.setTextColor(TERM_GREEN, TERM_BG);
    tft.setTextDatum(TL_DATUM); // Zarovnání vlevo nahoře
    String line = ">";
    line += text;
    tft.drawString(line, 0, 40); // 40 px odshora (pod textem)
    
    display_show_history(text);
}

void Display::display_show_history(const char* text){
    // Posun historie
    tft.fillRect(0, 56, tft.width(), 8, TERM_BG);
    tft.fillRect(0, 72, tft.width(), 8, TERM_BG);

    keyboard_history[2] = keyboard_history[1];
    keyboard_history[1] = keyboard_history[0];
    keyboard_history[0] = text;

    tft.setTextFont(1); // GLCD 8x8
    tft.setTextColor(TERM_HISTORY, TERM_BG);
    tft.setTextDatum(TL_DATUM); // Zarovnání vlevo nahoře
    tft.drawString(keyboard_history[1], 0, 56);
    tft.drawString(keyboard_history[2], 0, 72);
}

#else
// Dummy functions if no display is connected
void Display::display_init() {}
void Display::display_show_state(const char*) {}
void Display::display_show_debug(const char*) {}


#endif
