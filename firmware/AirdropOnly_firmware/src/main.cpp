#include <Arduino.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <FS.h>
#include <SD.h>
#include <SPI.h>
#include <USB.h>
#include <USBMSC.h>
#include <WiFi.h>

namespace {

constexpr char AP_SSID[] = "ESP32_IMG";
constexpr char AP_PASSWORD[] = "12345678";
constexpr char STORAGE_ROOT[] = "/upl";
constexpr size_t MAX_UPLOAD_BYTES = 10U * 1024U * 1024U;

constexpr int BUTTON_PIN = 0;
constexpr uint32_t BUTTON_DEBOUNCE_MS = 25;
constexpr uint32_t BUTTON_LONG_PRESS_MS = 750;
constexpr uint32_t MSC_DETACH_SETTLE_MS = 250;

constexpr int SD_MISO_PIN = 16;
constexpr int SD_MOSI_PIN = 18;
constexpr int SD_SCK_PIN = 17;
constexpr int SD_CS_PIN = 47;
constexpr uint32_t SD_SPI_FREQUENCY = 4U * 1000U * 1000U;

enum class StorageMode : uint8_t {
    USB_STORAGE,
    HTTP_TRANSFER,
    ERROR,
};

struct UploadContext {
    File file;
    String filename;
    String final_path;
    String temporary_path;
    size_t expected_bytes = 0;
    size_t written_bytes = 0;
    int response_status = 201;
    String error_code;
    String error_message;
    bool initialized = false;
    bool finished = false;

    bool ok() const {
        return response_status == 201;
    }

    void fail(int status, const char* code, const char* message) {
        if (!ok()) {
            return;
        }
        response_status = status;
        error_code = code;
        error_message = message;
    }
};

fs::SDFS& storage = SD;
USBMSC msc;
AsyncWebServer server(80);

SemaphoreHandle_t storage_mutex = nullptr;
volatile StorageMode storage_mode = StorageMode::ERROR;
volatile bool upload_active = false;
volatile bool download_active = false;
bool storage_ready = false;
bool msc_started = false;

alignas(4) uint8_t msc_sector_buffer[512];

const char* mode_name(StorageMode mode) {
    switch (mode) {
        case StorageMode::USB_STORAGE:
            return "usb_storage";
        case StorageMode::HTTP_TRANSFER:
            return "http_transfer";
        case StorageMode::ERROR:
        default:
            return "error";
    }
}

String json_escape(const String& value) {
    String escaped;
    escaped.reserve(value.length() + 8);
    for (size_t i = 0; i < value.length(); ++i) {
        const uint8_t c = static_cast<uint8_t>(value[i]);
        switch (c) {
            case '"':
                escaped += "\\\"";
                break;
            case '\\':
                escaped += "\\\\";
                break;
            case '\b':
                escaped += "\\b";
                break;
            case '\f':
                escaped += "\\f";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                if (c < 0x20) {
                    char unicode_escape[7];
                    snprintf(unicode_escape, sizeof(unicode_escape), "\\u%04x", c);
                    escaped += unicode_escape;
                } else {
                    escaped += static_cast<char>(c);
                }
        }
    }
    return escaped;
}

void send_error(
    AsyncWebServerRequest* request,
    int status,
    const String& code,
    const String& message
) {
    String body = "{\"ok\":false,\"code\":\"";
    body += json_escape(code);
    body += "\",\"message\":\"";
    body += json_escape(message);
    body += "\"}";
    request->send(status, "application/json", body);
}

bool is_http_mode() {
    return storage_ready && storage_mode == StorageMode::HTTP_TRANSFER;
}

bool validate_filename(const String& filename, String& reason) {
    if (filename.isEmpty() || filename.length() > 64) {
        reason = "Filename must contain between 1 and 64 UTF-8 bytes.";
        return false;
    }

    if (filename.indexOf('/') >= 0
        || filename.indexOf('\\') >= 0
        || filename.indexOf("..") >= 0) {
        reason = "Filename must be a basename without path traversal.";
        return false;
    }

    for (size_t i = 0; i < filename.length(); ++i) {
        const uint8_t c = static_cast<uint8_t>(filename[i]);
        if (c < 0x20 || c == 0x7f) {
            reason = "Filename contains a control character.";
            return false;
        }
    }

    String lowercase = filename;
    lowercase.toLowerCase();
    if (lowercase.endsWith(".part")) {
        reason = "The .part suffix is reserved for incomplete transfers.";
        return false;
    }

    return true;
}

String file_path(const String& filename) {
    return String(STORAGE_ROOT) + "/" + filename;
}

void remove_partial_files() {
    File directory = storage.open(STORAGE_ROOT);
    if (!directory || !directory.isDirectory()) {
        return;
    }

    File entry = directory.openNextFile();
    while (entry) {
        String path = entry.path();
        const bool remove_entry = !entry.isDirectory() && path.endsWith(".part");
        entry.close();
        if (remove_entry) {
            storage.remove(path);
            Serial.printf("[SD] Removed incomplete upload: %s\n", path.c_str());
        }
        entry = directory.openNextFile();
    }
    directory.close();
}

UploadContext* upload_context(AsyncWebServerRequest* request) {
    return static_cast<UploadContext*>(request->_tempObject);
}

void close_failed_upload(UploadContext* context) {
    if (context == nullptr) {
        return;
    }
    if (context->file) {
        context->file.close();
    }
    if (!context->temporary_path.isEmpty() && storage.exists(context->temporary_path)) {
        storage.remove(context->temporary_path);
    }
}

UploadContext* begin_upload(AsyncWebServerRequest* request, size_t total) {
    auto* context = new UploadContext();
    request->_tempObject = context;
    context->expected_bytes = total;
    request->onDisconnect([request]() {
        UploadContext* abandoned = upload_context(request);
        if (abandoned == nullptr) {
            return;
        }
        if (abandoned->initialized && !abandoned->finished) {
            abandoned->fail(500, "client_disconnected", "The upload client disconnected.");
            close_failed_upload(abandoned);
            upload_active = false;
            Serial.printf(
                "[HTTP] Upload interrupted: %s\n",
                abandoned->filename.c_str()
            );
        }
        delete abandoned;
        request->_tempObject = nullptr;
    });

    if (!is_http_mode()) {
        context->fail(
            409,
            "wrong_mode",
            "Switch the device to HTTP Transfer mode with a long button press."
        );
        return context;
    }

    if (upload_active || download_active) {
        context->fail(409, "transfer_busy", "Another file transfer is already active.");
        return context;
    }

    if (!request->hasHeader("Content-Length")) {
        context->fail(400, "length_required", "Content-Length is required.");
        return context;
    }

    if (total > MAX_UPLOAD_BYTES) {
        context->fail(413, "file_too_large", "The maximum upload size is 10 MiB.");
        return context;
    }

    const String content_type = request->header("Content-Type");
    if (!content_type.startsWith("application/octet-stream")) {
        context->fail(
            400,
            "invalid_content_type",
            "Content-Type must be application/octet-stream."
        );
        return context;
    }

    if (!request->hasParam("name")) {
        context->fail(400, "missing_filename", "The name query parameter is required.");
        return context;
    }

    context->filename = request->getParam("name")->value();
    String reason;
    if (!validate_filename(context->filename, reason)) {
        context->fail(400, "invalid_filename", reason.c_str());
        return context;
    }

    context->final_path = file_path(context->filename);
    context->temporary_path = context->final_path + ".part";

    upload_active = true;
    storage.remove(context->temporary_path);
    context->file = storage.open(context->temporary_path, FILE_WRITE);
    if (!context->file) {
        context->fail(500, "open_failed", "Could not create the temporary file on the SD card.");
        upload_active = false;
        return context;
    }
    context->initialized = true;

    Serial.printf(
        "[HTTP] Upload started: %s (%u bytes)\n",
        context->filename.c_str(),
        static_cast<unsigned>(total)
    );
    return context;
}

void finish_upload(UploadContext* context) {
    if (context == nullptr || context->finished || !context->initialized) {
        return;
    }
    context->finished = true;

    if (context->file) {
        context->file.flush();
        context->file.close();
    }

    if (context->ok() && context->written_bytes != context->expected_bytes) {
        context->fail(500, "size_mismatch", "The received byte count did not match Content-Length.");
    }

    if (context->ok()) {
        if (storage.exists(context->final_path) && !storage.remove(context->final_path)) {
            context->fail(500, "replace_failed", "Could not replace the existing destination file.");
        }
    }

    if (context->ok() && !storage.rename(context->temporary_path, context->final_path)) {
        context->fail(500, "rename_failed", "Could not finalize the uploaded file.");
    }

    if (!context->ok()) {
        close_failed_upload(context);
        Serial.printf(
            "[HTTP] Upload failed: %s (%s)\n",
            context->filename.c_str(),
            context->error_code.c_str()
        );
    } else {
        Serial.printf(
            "[HTTP] Upload complete: %s (%u bytes)\n",
            context->filename.c_str(),
            static_cast<unsigned>(context->written_bytes)
        );
    }
    upload_active = false;
}

void handle_upload_body(
    AsyncWebServerRequest* request,
    uint8_t* data,
    size_t len,
    size_t index,
    size_t total
) {
    UploadContext* context = upload_context(request);
    if (context == nullptr) {
        context = begin_upload(request, total);
    }

    if (context == nullptr || !context->ok() || !context->initialized) {
        return;
    }

    if (index != context->written_bytes) {
        context->fail(500, "chunk_order", "Upload chunks arrived out of order.");
    } else if (context->written_bytes + len > context->expected_bytes) {
        context->fail(400, "body_too_large", "The request body exceeded Content-Length.");
    } else if (len > 0) {
        const size_t written = context->file.write(data, len);
        context->written_bytes += written;
        if (written != len) {
            context->fail(500, "write_failed", "The SD card did not accept the complete chunk.");
        }
    }

    if (!context->ok() || index + len == total) {
        finish_upload(context);
    }
}

void handle_upload_complete(AsyncWebServerRequest* request) {
    UploadContext* context = upload_context(request);

    // ESPAsyncWebServer may not invoke the body callback for a zero-byte body.
    if (context == nullptr && request->contentLength() == 0) {
        context = begin_upload(request, 0);
        finish_upload(context);
    }

    if (context == nullptr) {
        send_error(request, 400, "missing_body", "No upload body was received.");
        return;
    }

    if (!context->finished && context->initialized) {
        finish_upload(context);
    }

    if (context->ok()) {
        String body = "{\"ok\":true,\"name\":\"";
        body += json_escape(context->filename);
        body += "\",\"size\":";
        body += String(static_cast<unsigned>(context->written_bytes));
        body += "}";
        request->_tempObject = nullptr;
        delete context;
        request->send(201, "application/json", body);
    } else {
        const int status = context->response_status;
        const String code = context->error_code;
        const String message = context->error_message;
        request->_tempObject = nullptr;
        delete context;
        send_error(request, status, code, message);
    }
}

void handle_status(AsyncWebServerRequest* request) {
    String body = "{\"ok\":true,\"mode\":\"";
    body += mode_name(storage_mode);
    body += "\",\"storageReady\":";
    body += storage_ready ? "true" : "false";
    body += ",\"uploadActive\":";
    body += upload_active ? "true" : "false";
    body += ",\"downloadActive\":";
    body += download_active ? "true" : "false";
    body += ",\"maxUploadBytes\":";
    body += String(static_cast<unsigned>(MAX_UPLOAD_BYTES));
    body += ",\"ip\":\"";
    body += WiFi.softAPIP().toString();
    body += "\"}";
    request->send(200, "application/json", body);
}

void handle_list(AsyncWebServerRequest* request) {
    if (!is_http_mode()) {
        send_error(
            request,
            409,
            "wrong_mode",
            "File listing is available only in HTTP Transfer mode."
        );
        return;
    }
    if (upload_active || download_active) {
        send_error(request, 409, "transfer_busy", "A file transfer is currently active.");
        return;
    }

    File directory = storage.open(STORAGE_ROOT);
    if (!directory || !directory.isDirectory()) {
        send_error(request, 500, "directory_failed", "Could not open the upload directory.");
        return;
    }

    AsyncResponseStream* response = request->beginResponseStream("application/json");
    response->print("{\"ok\":true,\"files\":[");
    bool first = true;
    File entry = directory.openNextFile();
    while (entry) {
        if (!entry.isDirectory()) {
            String name = entry.name();
            const int slash = name.lastIndexOf('/');
            if (slash >= 0) {
                name = name.substring(slash + 1);
            }
            if (!name.endsWith(".part")) {
                if (!first) {
                    response->print(',');
                }
                response->printf(
                    "{\"name\":\"%s\",\"size\":%u}",
                    json_escape(name).c_str(),
                    static_cast<unsigned>(entry.size())
                );
                first = false;
            }
        }
        entry.close();
        entry = directory.openNextFile();
    }
    directory.close();
    response->print("]}");
    request->send(response);
}

void handle_download(AsyncWebServerRequest* request) {
    if (!is_http_mode()) {
        send_error(
            request,
            409,
            "wrong_mode",
            "Downloads are available only in HTTP Transfer mode."
        );
        return;
    }
    if (upload_active || download_active) {
        send_error(request, 409, "transfer_busy", "Another file transfer is already active.");
        return;
    }
    if (!request->hasParam("name")) {
        send_error(request, 400, "missing_filename", "The name query parameter is required.");
        return;
    }

    const String filename = request->getParam("name")->value();
    String reason;
    if (!validate_filename(filename, reason)) {
        send_error(request, 400, "invalid_filename", reason);
        return;
    }

    const String path = file_path(filename);
    if (!storage.exists(path)) {
        send_error(request, 404, "not_found", "The requested file does not exist.");
        return;
    }
    download_active = true;
    request->onDisconnect([]() {
        download_active = false;
    });
    request->send(storage, path, "application/octet-stream", true);
}

int32_t handle_msc_read(
    uint32_t lba,
    uint32_t offset,
    void* destination,
    uint32_t byte_count
) {
    if (!storage_ready
        || storage_mode != StorageMode::USB_STORAGE
        || storage.sectorSize() != sizeof(msc_sector_buffer)) {
        return -1;
    }

    const uint64_t first_byte = static_cast<uint64_t>(lba) * sizeof(msc_sector_buffer) + offset;
    const uint64_t card_bytes = static_cast<uint64_t>(storage.numSectors())
        * sizeof(msc_sector_buffer);
    if (first_byte + byte_count > card_bytes) {
        return -1;
    }

    if (xSemaphoreTake(storage_mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        return -1;
    }

    auto* output = static_cast<uint8_t*>(destination);
    uint64_t position = first_byte;
    uint32_t remaining = byte_count;
    bool success = true;

    while (remaining > 0) {
        const uint32_t sector = position / sizeof(msc_sector_buffer);
        const uint32_t sector_offset = position % sizeof(msc_sector_buffer);
        const uint32_t copy_count = min(
            remaining,
            static_cast<uint32_t>(sizeof(msc_sector_buffer) - sector_offset)
        );
        if (!storage.readRAW(msc_sector_buffer, sector)) {
            success = false;
            break;
        }
        memcpy(output, msc_sector_buffer + sector_offset, copy_count);
        output += copy_count;
        position += copy_count;
        remaining -= copy_count;
    }

    xSemaphoreGive(storage_mutex);
    return success ? static_cast<int32_t>(byte_count) : -1;
}

int32_t reject_msc_write(uint32_t, uint32_t, uint8_t*, uint32_t) {
    // The prototype intentionally exposes read-only storage to the USB host.
    return -1;
}

bool handle_msc_start_stop(uint8_t, bool, bool) {
    return true;
}

void switch_to_http_mode() {
    if (!storage_ready || storage_mode != StorageMode::USB_STORAGE) {
        return;
    }
    Serial.println("[MODE] Detaching USB storage...");
    msc.mediaPresent(false);
    if (xSemaphoreTake(storage_mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        Serial.println("[MODE] Storage busy; mode switch refused");
        msc.mediaPresent(true);
        return;
    }
    storage_mode = StorageMode::HTTP_TRANSFER;
    xSemaphoreGive(storage_mutex);
    delay(MSC_DETACH_SETTLE_MS);
    Serial.println("[MODE] HTTP Transfer mode ready");
}

void switch_to_usb_mode() {
    if (!storage_ready || storage_mode != StorageMode::HTTP_TRANSFER) {
        return;
    }
    if (upload_active || download_active) {
        Serial.println("[MODE] HTTP transfer active; USB mode switch refused");
        return;
    }
    if (xSemaphoreTake(storage_mutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        Serial.println("[MODE] Storage busy; mode switch refused");
        return;
    }

    Serial.println("[MODE] Presenting read-only USB storage...");
    storage_mode = StorageMode::USB_STORAGE;
    msc.mediaPresent(true);
    xSemaphoreGive(storage_mutex);
    Serial.println("[MODE] USB Storage mode ready");
}

void toggle_storage_mode() {
    if (storage_mode == StorageMode::USB_STORAGE) {
        switch_to_http_mode();
    } else if (storage_mode == StorageMode::HTTP_TRANSFER) {
        switch_to_usb_mode();
    }
}

void poll_mode_button() {
    static bool last_read = HIGH;
    static bool stable_read = HIGH;
    static uint32_t changed_at = 0;
    static uint32_t pressed_at = 0;

    const bool current = digitalRead(BUTTON_PIN);
    const uint32_t now = millis();
    if (current != last_read) {
        last_read = current;
        changed_at = now;
    }

    if (current == stable_read || now - changed_at < BUTTON_DEBOUNCE_MS) {
        return;
    }

    stable_read = current;
    if (stable_read == LOW) {
        pressed_at = now;
        return;
    }

    if (now - pressed_at >= BUTTON_LONG_PRESS_MS) {
        toggle_storage_mode();
    }
}

void configure_http_routes() {
    server.on("/status", HTTP_GET, handle_status);
    server.on("/list", HTTP_GET, handle_list);
    server.on("/download", HTTP_GET, handle_download);
    server.on("/upload_raw", HTTP_POST, handle_upload_complete, nullptr, handle_upload_body);
    server.onNotFound([](AsyncWebServerRequest* request) {
        send_error(request, 404, "route_not_found", "The requested endpoint does not exist.");
    });
}

bool initialize_storage() {
    pinMode(SD_CS_PIN, OUTPUT);
    digitalWrite(SD_CS_PIN, HIGH);
    SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);

    if (!storage.begin(
            SD_CS_PIN,
            SPI,
            SD_SPI_FREQUENCY,
            "/sdcard",
            5,
            false
        )) {
        Serial.println("[SD] Mount failed; insert a FAT32 card and reboot");
        return false;
    }
    if (storage.sectorSize() != sizeof(msc_sector_buffer)) {
        Serial.printf("[SD] Unsupported sector size: %u\n", storage.sectorSize());
        return false;
    }
    if (!storage.exists(STORAGE_ROOT) && !storage.mkdir(STORAGE_ROOT)) {
        Serial.println("[SD] Could not create /upl");
        return false;
    }
    remove_partial_files();
    Serial.printf(
        "[SD] SPI ready at %u Hz: %u sectors x %u bytes\n",
        SD_SPI_FREQUENCY,
        storage.numSectors(),
        storage.sectorSize()
    );
    return true;
}

bool initialize_usb_storage() {
    msc.vendorID("BKMD");
    msc.productID("BKMD Storage");
    msc.productRevision("1.0");
    msc.onStartStop(handle_msc_start_stop);
    msc.onRead(handle_msc_read);
    msc.onWrite(reject_msc_write);
    msc.mediaPresent(false);
    if (!msc.begin(storage.numSectors(), storage.sectorSize())) {
        Serial.println("[USB] Could not initialize MSC");
        return false;
    }
    USB.begin();
    msc.mediaPresent(true);
    Serial.println("[USB] Read-only mass storage started");
    return true;
}

}  // namespace

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\nBKMD HTTP/USB storage test starting");

    pinMode(BUTTON_PIN, INPUT_PULLUP);
    storage_mutex = xSemaphoreCreateMutex();
    if (storage_mutex == nullptr) {
        Serial.println("[INIT] Could not create storage mutex");
        storage_mode = StorageMode::ERROR;
    } else {
        storage_ready = initialize_storage();
        if (storage_ready) {
            msc_started = initialize_usb_storage();
            storage_mode = msc_started ? StorageMode::USB_STORAGE : StorageMode::ERROR;
        }
    }

    WiFi.mode(WIFI_AP);
    if (!WiFi.softAP(AP_SSID, AP_PASSWORD)) {
        Serial.println("[WiFi] Failed to start access point");
    } else {
        Serial.printf("[WiFi] Connect to %s, then use http://%s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
    }

    configure_http_routes();
    server.begin();
    Serial.printf("[HTTP] Server started; mode=%s\n", mode_name(storage_mode));
}

void loop() {
    poll_mode_button();
    delay(5);
}
