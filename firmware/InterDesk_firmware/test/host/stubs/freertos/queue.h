#pragma once
#include <vector>
#include <deque>
#include <cstring>
struct TestQueue {
    size_t capacity;
    size_t itemSize;
    std::deque<std::vector<uint8_t>> items;
};
using QueueHandle_t = TestQueue*;
inline void xQueueReset(QueueHandle_t queue) { queue->items.clear(); }
inline int xQueueSend(QueueHandle_t queue, const void* data, int) {
    if (queue->items.size() == queue->capacity) return 0;
    const auto* bytes = static_cast<const uint8_t*>(data);
    queue->items.emplace_back(bytes, bytes + queue->itemSize);
    return pdTRUE;
}
