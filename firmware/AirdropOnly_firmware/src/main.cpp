/*
After upload, run:

curl http://192.168.4.1/list
You should see test.jpg <size> bytes
*/

/**
 * ESP32 + ESPAsyncWebServer + FreeRTOS SD-writer task
 * - ESP32 runs as Wi-Fi AP
 * - HTTP upload endpoints:
 *    1) POST /upload_raw   (raw binary body, recommended)
 *    2) POST /upload_form  (multipart/form-data file field, like curl -F)
 * - Data is NOT written to SD inside HTTP callbacks.
 *   Instead, callbacks copy chunks and enqueue them to a FreeRTOS writer task.
 *
 * Test from PC (connected to ESP32 AP):
 *   RAW (recommended):
 *     curl -v -X POST "http://192.168.4.1/upload_raw?name=test.jpg" \
 *       -H "Content-Type: application/octet-stream" \
 *       --data-binary "@test.jpg"
 *
 *   MULTIPART:
 *     curl -v -X POST http://192.168.4.1/upload_form \
 *       -F "file=@test.jpg;type=image/jpeg"
 *
 * Verify:
 *   curl -v http://192.168.4.1/list
 *   curl -o back.jpg "http://192.168.4.1/download?name=test.jpg"
 */

#include <Arduino.h>
#include <WiFi.h>


#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>

#include <FS.h>

// ===== SD backend selection =====
#define USE_SD_MMC 1   // set to 1 if you wired SD to SDMMC (4-bit/1-bit) and want SD_MMC

#if USE_SD_MMC
  #include <SD_MMC.h>
  fs::FS &SDX = SD_MMC;
#else
  #include <SD.h>
  #include <SPI.h>
  fs::FS &SDX = SD;
  // If using SPI SD, set your CS pin here:
  static const int SD_CS_PIN = 5; // change to your wiring
#endif


// ===== Wi-Fi AP =====
static const char* AP_SSID = "ESP32_IMG";
static const char* AP_PASS = "12345678"; // >=8 chars

// ===== Upload/write pipeline =====
static const char* BASE_DIR = "/upl";      // folder on SD
static const size_t QUEUE_DEPTH = 16;      // number of queued chunks
static const uint32_t ENQUEUE_TIMEOUT_MS = 50; // keep HTTP callbacks snappy

enum MsgType : uint8_t { MSG_START, MSG_DATA, MSG_DONE, MSG_ABORT };

struct SdMsg {
  MsgType type;
  char name[64];      // used for MSG_START
  uint8_t* data;      // used for MSG_DATA
  size_t len;         // used for MSG_DATA
};

static QueueHandle_t sdQueue;
static SemaphoreHandle_t sdMutex;

static volatile bool g_overflow = false;   // set if malloc/queue fails during an upload

// ===== Web server =====
AsyncWebServer server(80);

// ===== Helpers =====
static String safeJoinPath(const char* dir, const char* name) {
  String n(name);
  n.replace("..", "");
  n.replace("\\", "/");
  while (n.startsWith("/")) n.remove(0, 1);
  return String(dir) + "/" + n;
}

static bool ensureDir(fs::FS &fs, const char* path) {
  if (fs.exists(path)) return true;
  return fs.mkdir(path);
}

static size_t fileSize(fs::FS &fs, const char* path) {
  File f = fs.open(path, FILE_READ);
  if (!f) return 0;
  size_t s = f.size();
  f.close();
  return s;
}

// ===== SD writer task =====
static void sdWriterTask(void* arg) {
  File out;
  String outPath;

  for (;;) {
    SdMsg m;
    if (xQueueReceive(sdQueue, &m, portMAX_DELAY) != pdTRUE) continue;

    if (m.type == MSG_START) {
      // close any previous
      if (out) out.close();

      xSemaphoreTake(sdMutex, portMAX_DELAY);

      ensureDir(SDX, BASE_DIR);
      outPath = safeJoinPath(BASE_DIR, m.name);

      // overwrite each upload by name
      out = SDX.open(outPath, FILE_WRITE);
      xSemaphoreGive(sdMutex);

      if (!out) {
        Serial.printf("[SD] Failed to open %s\n", outPath.c_str());
      } else {
        Serial.printf("[SD] Writing -> %s\n", outPath.c_str());
      }
    }
    else if (m.type == MSG_DATA) {
      if (out && m.data && m.len) {
        xSemaphoreTake(sdMutex, portMAX_DELAY);
        size_t w = out.write(m.data, m.len);
        xSemaphoreGive(sdMutex);
        if (w != m.len) {
          Serial.printf("[SD] Short write: %u/%u\n", (unsigned)w, (unsigned)m.len);
        }
      }
      if (m.data) free(m.data);
    }
    else if (m.type == MSG_DONE) {
      if (out) {
        xSemaphoreTake(sdMutex, portMAX_DELAY);
        out.flush();
        out.close();
        xSemaphoreGive(sdMutex);
        Serial.printf("[SD] Done -> %s (size=%u)\n", outPath.c_str(),
                      (unsigned)fileSize(SDX, outPath.c_str()));
      }
    }
    else if (m.type == MSG_ABORT) {
      if (out) {
        xSemaphoreTake(sdMutex, portMAX_DELAY);
        out.close();
        xSemaphoreGive(sdMutex);
        Serial.println("[SD] Aborted upload (file closed)");
      }
    }
  }
}

// enqueue helpers
static bool enqueueStart(const char* name) {
  SdMsg m{};
  m.type = MSG_START;
  strlcpy(m.name, name, sizeof(m.name));
  return xQueueSend(sdQueue, &m, pdMS_TO_TICKS(ENQUEUE_TIMEOUT_MS)) == pdTRUE;
}
static bool enqueueData(const uint8_t* data, size_t len) {
  uint8_t* copy = (uint8_t*)malloc(len);
  if (!copy) return false;
  memcpy(copy, data, len);

  SdMsg m{};
  m.type = MSG_DATA;
  m.data = copy;
  m.len  = len;

  if (xQueueSend(sdQueue, &m, pdMS_TO_TICKS(ENQUEUE_TIMEOUT_MS)) != pdTRUE) {
    free(copy);
    return false;
  }
  return true;
}
static void enqueueDone() {
  SdMsg m{};
  m.type = MSG_DONE;
  xQueueSend(sdQueue, &m, pdMS_TO_TICKS(ENQUEUE_TIMEOUT_MS));
}
static void enqueueAbort() {
  SdMsg m{};
  m.type = MSG_ABORT;
  xQueueSend(sdQueue, &m, pdMS_TO_TICKS(ENQUEUE_TIMEOUT_MS));
}

// ===== Routes =====
static void setupRoutes() {
  server.on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
    req->send(200, "text/plain",
      "ESP32 up.\n"
      "POST /upload_raw?name=FILE (raw body)\n"
      "POST /upload_form (multipart field 'file')\n"
      "GET  /list\n"
      "GET  /download?name=FILE\n");
  });

  // List uploaded files (names + sizes)
  server.on("/list", HTTP_GET, [](AsyncWebServerRequest* req) {
    ensureDir(SDX, BASE_DIR);
    File dir = SDX.open(BASE_DIR);
    if (!dir || !dir.isDirectory()) {
      req->send(500, "text/plain", "Cannot open dir");
      return;
    }

    String out = "Files:\n";
    File f = dir.openNextFile();
    while (f) {
      out += String(f.name()) + "  " + String((unsigned)f.size()) + " bytes\n";
      f = dir.openNextFile();
    }
    req->send(200, "text/plain", out);
  });

  // Download a stored file back (verify on PC)
  server.on("/download", HTTP_GET, [](AsyncWebServerRequest* req) {
    if (!req->hasParam("name")) {
      req->send(400, "text/plain", "Missing ?name=");
      return;
    }
    String name = req->getParam("name")->value();
    String path = safeJoinPath(BASE_DIR, name.c_str());
    if (!SDX.exists(path)) {
      req->send(404, "text/plain", "Not found");
      return;
    }
    // content-type left generic; your PC can still compare bytes/hashes
    req->send(SDX, path, "application/octet-stream", true);
  });

  // RAW upload (recommended): POST body is exactly the file bytes
  // Use: curl --data-binary "@file" "http://192.168.4.1/upload_raw?name=file.jpg"
  server.on("/upload_raw", HTTP_POST,
    [](AsyncWebServerRequest* req) {
      // Final response after body callbacks finished
      if (g_overflow) {
        g_overflow = false;
        req->send(503, "text/plain", "Upload failed (buffer/queue overflow)");
      } else {
        req->send(200, "text/plain", "OK");
      }
    },
    nullptr,
    [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
      // Called multiple times while body arrives
      if (index == 0) {
        g_overflow = false;
        const char* name = "upload.bin";
        if (req->hasParam("name")) name = req->getParam("name")->value().c_str();
        if (!enqueueStart(name)) {
          g_overflow = true;
          enqueueAbort();
          return;
        }
      }

      if (len) {
        if (!enqueueData(data, len)) {
          g_overflow = true;
          enqueueAbort();
          return;
        }
      }

      if (index + len == total) {
        enqueueDone();
      }
    }
  );

  // MULTIPART upload (like curl -F "file=@x.jpg"):
  // POST /upload_form with field name "file"
  server.on("/upload_form", HTTP_POST,
    [](AsyncWebServerRequest* req) {
      if (g_overflow) {
        g_overflow = false;
        req->send(503, "text/plain", "Upload failed (buffer/queue overflow)");
      } else {
        req->send(200, "text/plain", "OK");
      }
    },
    [](AsyncWebServerRequest* req, String filename, size_t index, uint8_t* data, size_t len, bool final) {
      if (index == 0) {
        g_overflow = false;
        if (!enqueueStart(filename.c_str())) {
          g_overflow = true;
          enqueueAbort();
          return;
        }
      }
      if (len) {
        if (!enqueueData(data, len)) {
          g_overflow = true;
          enqueueAbort();
          return;
        }
      }
      if (final) {
        enqueueDone();
      }
    }
  );
}

void setup() {
  Serial.begin(115200);
  delay(2000);

  // Init SD
#if USE_SD_MMC
  int clk = 36;
  int cmd = 35;
  int d0  = 37;
  int d1  = 38;
  int d2  = 33;
  int d3  = 34;
  bool onebit = false; // false = 4-bit

  SD_MMC.setPins(clk, cmd, d0, d1, d2, d3);

  if (!SD_MMC.begin("/sdcard", onebit)) {
    Serial.println("SD_MMC mount failed");
  } else {
    Serial.println("SD_MMC mounted OK");
  }



#else
  SPI.begin(); // uses default pins; set if you have custom wiring
  if (!SD.begin(SD_CS_PIN)) {
    Serial.println("[SD] SD.begin() failed (SPI). Check CS/pins.");
  } else {
    Serial.println("[SD] SD mounted (SPI)");
  }
#endif
  ensureDir(SDX, BASE_DIR);

  // Create queue/mutex and start SD writer task
  sdQueue = xQueueCreate(QUEUE_DEPTH, sizeof(SdMsg));
  sdMutex = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(sdWriterTask, "sd_writer", 4096, nullptr, 10, nullptr, 1); // core 1

  // Start AP
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print("[WiFi] AP IP: ");
  Serial.println(WiFi.softAPIP());

  // Start HTTP server
  setupRoutes();
  server.begin();
  Serial.println("[HTTP] Server started");
}

void loop() {
  // ESPAsyncWebServer does not need handleClient() here
}
