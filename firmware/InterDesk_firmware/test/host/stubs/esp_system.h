#pragma once
inline uint32_t esp_random() { static uint32_t random = 654320; return ++random; }
