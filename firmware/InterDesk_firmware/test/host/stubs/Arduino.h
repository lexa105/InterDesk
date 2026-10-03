#pragma once
#include <cstdint>
#include <cstddef>
#include <cstring>
inline uint32_t testMillis = 0;
inline uint32_t millis() { return testMillis; }
struct TestSerial {
    void println(const char*) {}
    template<typename... Args> void printf(const char*, Args...) {}
};
inline TestSerial Serial;
