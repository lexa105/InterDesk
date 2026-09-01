/*
*
*Display class for debug
*
*/
#include <Arduino.h>

#pragma once

struct UiState {
    char debug[96];
    bool AirDropOn;
};

class Display
{
private:
    void display_show_history(const char* text);
public:
    void display_init();
    void display_show_state(const char* state);
    void display_show_debug(const char* text);
};



