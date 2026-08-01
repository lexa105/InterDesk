#include <Arduino.h>
#include <FS.h>
#include <SD.h>
#include <SPI.h>

namespace {

constexpr int SD_MISO_PIN = 16;
constexpr int SD_MOSI_PIN = 18;
constexpr int SD_SCK_PIN = 17;
constexpr int SD_CS_PIN = 47;
constexpr uint32_t SD_SPI_FREQUENCY = 4U * 1000U * 1000U;

constexpr char TEST_FILE_PATH[] = "/bkmd_sd_test.txt";
constexpr char TEST_CONTENT[] = "BKMD SD card test passed\n";

const char* card_type_name(uint8_t card_type) {
    switch (card_type) {
        case CARD_MMC:
            return "MMC";
        case CARD_SD:
            return "SDSC";
        case CARD_SDHC:
            return "SDHC/SDXC";
        case CARD_NONE:
            return "none";
        default:
            return "unknown";
    }
}

void print_card_information() {
    const uint8_t card_type = SD.cardType();
    Serial.printf("[SD] Card type: %s\n", card_type_name(card_type));
    Serial.printf("[SD] Card size: %llu bytes (%llu MiB)\n",
                  SD.cardSize(),
                  SD.cardSize() / (1024ULL * 1024ULL));
    Serial.printf("[SD] Filesystem size: %llu bytes\n", SD.totalBytes());
    Serial.printf("[SD] Filesystem used: %llu bytes\n", SD.usedBytes());
}

void list_root_directory() {
    File root = SD.open("/");
    if (!root || !root.isDirectory()) {
        Serial.println("[LIST] FAIL: could not open the root directory");
        return;
    }

    Serial.println("[LIST] Root directory:");
    bool found_entry = false;
    File entry = root.openNextFile();
    while (entry) {
        found_entry = true;
        Serial.printf("  %s  %s  %llu bytes\n",
                      entry.isDirectory() ? "DIR " : "FILE",
                      entry.name(),
                      entry.size());
        entry.close();
        entry = root.openNextFile();
    }
    root.close();

    if (!found_entry) {
        Serial.println("  (empty)");
    }
}

bool test_file_io() {
    if (SD.exists(TEST_FILE_PATH) && !SD.remove(TEST_FILE_PATH)) {
        Serial.printf("[WRITE] FAIL: could not remove old %s\n", TEST_FILE_PATH);
        return false;
    }

    File output = SD.open(TEST_FILE_PATH, FILE_WRITE);
    if (!output) {
        Serial.printf("[WRITE] FAIL: could not create %s\n", TEST_FILE_PATH);
        return false;
    }

    const size_t expected_size = strlen(TEST_CONTENT);
    const size_t written_size = output.write(
        reinterpret_cast<const uint8_t*>(TEST_CONTENT), expected_size);
    output.flush();
    output.close();

    if (written_size != expected_size) {
        Serial.printf("[WRITE] FAIL: wrote %u of %u bytes\n",
                      static_cast<unsigned>(written_size),
                      static_cast<unsigned>(expected_size));
        SD.remove(TEST_FILE_PATH);
        return false;
    }
    Serial.printf("[WRITE] PASS: wrote %u bytes\n",
                  static_cast<unsigned>(written_size));

    File input = SD.open(TEST_FILE_PATH, FILE_READ);
    if (!input) {
        Serial.printf("[READ] FAIL: could not reopen %s\n", TEST_FILE_PATH);
        SD.remove(TEST_FILE_PATH);
        return false;
    }

    String received = input.readString();
    input.close();
    if (received != TEST_CONTENT) {
        Serial.printf("[READ] FAIL: expected %u bytes, received %u bytes\n",
                      static_cast<unsigned>(expected_size),
                      static_cast<unsigned>(received.length()));
        SD.remove(TEST_FILE_PATH);
        return false;
    }
    Serial.println("[READ] PASS: contents match");

    if (!SD.remove(TEST_FILE_PATH)) {
        Serial.printf("[DELETE] FAIL: could not remove %s\n", TEST_FILE_PATH);
        return false;
    }
    Serial.println("[DELETE] PASS: temporary file removed");
    return true;
}

}  // namespace

void setup() {
    Serial.begin(115200);
    Serial.setDebugOutput(true);

    // This diagnostic is normally opened after PlatformIO finishes uploading.
    // Native USB CDC re-enumerates during that transition, so do not run and
    // lose the one-shot results before a serial monitor is actually attached.
    while (!Serial) {
        delay(50);
    }
    delay(500);

    Serial.println();
    Serial.println("========================================");
    Serial.println("BKMD standalone SPI SD diagnostic");
    Serial.println("Pins: MISO=16 MOSI=18 SCK=17 CS=47");
    Serial.printf("Mode: SPI at %u Hz\n", SD_SPI_FREQUENCY);
    Serial.println("========================================");

    pinMode(SD_CS_PIN, OUTPUT);
    digitalWrite(SD_CS_PIN, HIGH);
    SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
    Serial.println("[SPI] Bus initialized");

    Serial.println("[MOUNT] Calling SD.begin(CS, SPI, 4000000)");
    if (!SD.begin(SD_CS_PIN, SPI, SD_SPI_FREQUENCY)) {
        Serial.println("[MOUNT] FAIL");
        Serial.println("Check the driver error immediately above this line.");
        Serial.println("RESULT: FAIL");
        return;
    }
    Serial.println("[MOUNT] PASS");

    print_card_information();
    list_root_directory();

    if (!test_file_io()) {
        Serial.println("RESULT: FAIL");
        return;
    }

    Serial.println("RESULT: PASS - mount, write, read, and delete succeeded");
}

void loop() {
    delay(1000);
}
