/*
  VoiceHome Control with System Indicator LED
  Board: ESP8266 NodeMCU
  Database: Neon PostgreSQL through the backend API

  Workflow:
  1. ESP8266 polls the backend every 3 seconds.
  2. Backend retrieves pending commands from Neon.
  3. ESP8266 executes the command.
  4. ESP8266 sends an acknowledgment.
  5. Backend updates Neon and the frontend reads the new state.

  Indicator LED (D8 / GPIO15):
  - Solid ON: Wi-Fi connected and recent heartbeat confirms backend/database access.
  - Slow blinking (1s): Wi-Fi connected, but heartbeat/database confirmation is missing or failing.
  - Fast blinking (200ms): Wi-Fi disconnected.

  Install library:
  ArduinoJson by Benoit Blanchon
*/

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

// =====================================
// 1. WIFI SETTINGS
// =====================================

// Same network as the machine running `next dev`.
const char* WIFI_NAME = "Infinix SMART 6";
const char* WIFI_PASSWORD = "22334455";

// =====================================
// 2. BACKEND SETTINGS
// =====================================

// Origin only (no /api suffix, the code appends /api/... itself).
// Deployed Render service URL (HTTPS). For local dev, use the PC's LAN IP
// instead, e.g. "http://192.168.72.142:3000".
// Do not put the Neon database URL here.

const char* API_BASE = "https://voicehomecontrol.onrender.com";

const char* CONTROLLER_ID = "VH-ESP8266-001";

// Same value as DEVICE_API_KEY in .env.local.
// Sent as "Authorization: Bearer <key>" on every backend request.

const char* DEVICE_API_KEY = "vh_b502f6dd9560f557fbe10d93376b173318acf2dda2b4966fb08c22473dcee616";

// The backend is served over HTTPS (Render), so requests use
// WiFiClientSecure with setInsecure() to skip certificate validation.
// For plain-HTTP local dev, swap these back to WiFiClient.

// =====================================
// 3. TIMING & INDICATOR SETTINGS
// =====================================

const unsigned long POLL_INTERVAL = 3000;
const unsigned long HEARTBEAT_INTERVAL = 10000;
const unsigned long HEARTBEAT_TIMEOUT = 30000; // 30 seconds

// Delay before (re)sending an acknowledgment. Waiting a couple of seconds on a
// later loop pass lets the polling request's TLS context be fully released
// before a new WiFiClientSecure is created, which prevents the HTTP: -1
// connection failure caused by two TLS sessions fighting for the same heap.
const unsigned long ACK_RETRY_INTERVAL = 2000;

unsigned long lastPollTime = 0;
unsigned long lastHeartbeatTime = 0;
unsigned long lastHeartbeatSuccessMillis = 0;
unsigned long lastIndicatorUpdateMillis = 0;

bool heartbeatEverSucceeded = false;
bool indicatorLedState = false;

// Holds a command acknowledgment until the polling request has fully
// released its TLS context. The ack is retried on later loop passes and only
// cleared once the backend accepts it, so a transient HTTP: -1 (connection
// refused) no longer drops the acknowledgment and leaves the command to expire.

struct PendingAck {
  bool has;
  String commandId;
  bool success;
  String error;
  unsigned long lastAttempt;
};

PendingAck pendingAck = { false, "", false, "", 0 };

// D8 system indicator (GPIO15)
const int SYSTEM_LED_PIN = D8;
const bool LED_ACTIVE_HIGH = true; // Set false if your LED circuit is active-low

// =====================================
// 4. RELAY SETTINGS
// =====================================

// Many relay modules are active LOW.
// If your relay is active HIGH, change these values.

const int RELAY_ON = LOW;
const int RELAY_OFF = HIGH;

// Example relay pin assignments.
//
// Check your actual board and relay wiring before use.
// GPIO0, GPIO2 and GPIO15 have boot-related constraints.
// D4 and D8 can cause boot issues on some configurations.

const int relay1 = D1;
const int relay2 = D2;
const int relay3 = D5;
const int relay4 = D6;
const int relay5 = D7;

// Store the last commanded state of each relay.

bool relay1State = false;
bool relay2State = false;
bool relay3State = false;
bool relay4State = false;
bool relay5State = false;

// =====================================
// 5. FUNCTION DECLARATIONS
// =====================================

void connectWiFi();
void checkForCommand();
void sendHeartbeat();
void updateSystemIndicator();
void executeCommand(const char* pin, const char* action);
bool acknowledgeCommand(
  const String& commandId,
  bool success,
  const String& errorMessage
);
int findRelay(const char* pin);
void setRelay(int relayNumber, bool turnOn);

// =====================================
// 6. SETUP
// =====================================

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("VoiceHome ESP8266 Starting...");

  // Configure system LED pin (start in OFF state)
  digitalWrite(SYSTEM_LED_PIN, LED_ACTIVE_HIGH ? LOW : HIGH);
  pinMode(SYSTEM_LED_PIN, OUTPUT);
  digitalWrite(SYSTEM_LED_PIN, LED_ACTIVE_HIGH ? LOW : HIGH);

  // Configure relay pins.
  pinMode(relay1, OUTPUT);
  pinMode(relay2, OUTPUT);
  pinMode(relay3, OUTPUT);
  pinMode(relay4, OUTPUT);
  pinMode(relay5, OUTPUT);

  // Start with all relay outputs OFF.
  digitalWrite(relay1, RELAY_OFF);
  digitalWrite(relay2, RELAY_OFF);
  digitalWrite(relay3, RELAY_OFF);
  digitalWrite(relay4, RELAY_OFF);
  digitalWrite(relay5, RELAY_OFF);

  connectWiFi();

  Serial.println("VoiceHome is ready.");
  Serial.println("Command polling interval: 3 seconds.");
}

// =====================================
// 7. MAIN LOOP
// =====================================

void loop() {
  // Reconnect if Wi-Fi disconnects.
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  unsigned long currentTime = millis();

  if (WiFi.status() == WL_CONNECTED) {
    // Check for a command every 3 seconds.
    if (currentTime - lastPollTime >= POLL_INTERVAL) {
      lastPollTime = currentTime;
      checkForCommand();
    }

    // Acknowledge on a later loop pass, once the poll's TLS context has been
    // fully released, and keep retrying until the backend accepts it. The ack
    // is only cleared on success so an HTTP: -1 failure is not lost.
    if (pendingAck.has &&
        currentTime - pendingAck.lastAttempt >= ACK_RETRY_INTERVAL) {
      pendingAck.lastAttempt = currentTime;

      if (acknowledgeCommand(pendingAck.commandId, pendingAck.success, pendingAck.error)) {
        pendingAck.has = false;
      } else {
        Serial.println("Acknowledgment not accepted; will retry.");
      }
    }

    // Send heartbeat every 10 seconds.
    if (currentTime - lastHeartbeatTime >= HEARTBEAT_INTERVAL) {
      lastHeartbeatTime = currentTime;
      sendHeartbeat();
    }
  }

  // Update system indicator LED continuously
  updateSystemIndicator();

  // Allow other tasks to run.
  yield();
}

// =====================================
// 8. CONNECT TO WIFI
// =====================================

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.println("Connecting to Wi-Fi...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_NAME, WIFI_PASSWORD);

  unsigned long startTime = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - startTime < 15000) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi connected.");
    Serial.print("ESP8266 IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi connection failed. Will retry.");
  }
}

// =====================================
// 9. CHECK FOR A NEW COMMAND
// =====================================

void checkForCommand() {
  Serial.println("Checking backend for commands...");

  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(512, 512);

  HTTPClient http;

  // Trailing slash required: next.config.ts sets trailingSlash: true,
  // otherwise Next.js answers with a 308 redirect the ESP8266 cannot follow.
  String url = String(API_BASE) +
               "/api/controllers/" +
               CONTROLLER_ID +
               "/commands/";

  if (!http.begin(client, url)) {
    Serial.println("Could not start HTTP request.");
    return;
  }

  http.setTimeout(30000);
  http.addHeader("Authorization",
                 String("Bearer ") + DEVICE_API_KEY);

  int responseCode = http.GET();

  if (responseCode == 200) {
    String response = http.getString();

    Serial.println("Backend response:");
    Serial.println(response);

    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, response);

    if (error) {
      Serial.print("JSON error: ");
      Serial.println(error.c_str());
      http.end();
      client.stop();
      return;
    }

    if (doc["command"].isNull()) {
      Serial.println("No pending command.");
      http.end();
      client.stop();
      return;
    }

    JsonObject command = doc["command"];

    String commandId = command["id"] | "";
    String pin = command["pin"] | "";
    String action = command["action"] | "";

    if (commandId.length() == 0 ||
        pin.length() == 0 ||
        action.length() == 0) {
      Serial.println("Invalid command received.");
      http.end();
      client.stop();
      return;
    }

    Serial.println("New command received.");
    Serial.print("Command ID: ");
    Serial.println(commandId);
    Serial.print("Pin: ");
    Serial.println(pin);
    Serial.print("Action: ");
    Serial.println(action);

    http.end();
    client.stop();

    executeCommand(pin.c_str(), action.c_str());

    int relayNumber = findRelay(pin.c_str());
    bool validAction =
      action.equalsIgnoreCase("ON") ||
      action.equalsIgnoreCase("OFF");

    // Queue the ack for the main loop instead of sending it here. Sending it
    // now would keep this request's TLS context alive alongside the ack's.
    pendingAck.has = true;
    pendingAck.commandId = commandId;
    pendingAck.success = (relayNumber >= 1 && validAction);
    pendingAck.error = pendingAck.success ? "" : "Unsupported pin or action";
    pendingAck.lastAttempt = millis();

  } else {
    Serial.print("Command request failed. HTTP: ");
    Serial.println(responseCode);
    http.end();
    client.stop();
  }
}

// =====================================
// 10. FIND THE RELAY FOR A GPIO PIN
// =====================================

int findRelay(const char* pin) {
  if (strcmp(pin, "D1") == 0) {
    return 1;
  }

  if (strcmp(pin, "D2") == 0) {
    return 2;
  }

  if (strcmp(pin, "D5") == 0) {
    return 3;
  }

  if (strcmp(pin, "D6") == 0) {
    return 4;
  }

  if (strcmp(pin, "D7") == 0) {
    return 5;
  }

  return 0;
}

// =====================================
// 11. EXECUTE A COMMAND
// =====================================

void executeCommand(const char* pin, const char* action) {
  int relayNumber = findRelay(pin);

  if (relayNumber == 0) {
    Serial.println("Error: Unsupported GPIO pin.");
    return;
  }

  bool turnOn;

  if (strcmp(action, "ON") == 0 ||
      strcmp(action, "on") == 0) {
    turnOn = true;
  } else if (strcmp(action, "OFF") == 0 ||
             strcmp(action, "off") == 0) {
    turnOn = false;
  } else {
    Serial.println("Error: Unsupported action.");
    return;
  }

  setRelay(relayNumber, turnOn);

  Serial.print("Command applied to ");
  Serial.println(pin);
}

// =====================================
// 12. CHANGE RELAY STATE
// =====================================

void setRelay(int relayNumber, bool turnOn) {
  int outputPin;
  int outputLevel;

  switch (relayNumber) {
    case 1:
      outputPin = relay1;
      relay1State = turnOn;
      break;

    case 2:
      outputPin = relay2;
      relay2State = turnOn;
      break;

    case 3:
      outputPin = relay3;
      relay3State = turnOn;
      break;

    case 4:
      outputPin = relay4;
      relay4State = turnOn;
      break;

    case 5:
      outputPin = relay5;
      relay5State = turnOn;
      break;

    default:
      return;
  }

  outputLevel = turnOn ? RELAY_ON : RELAY_OFF;

  digitalWrite(outputPin, outputLevel);

  Serial.print("Relay ");
  Serial.print(relayNumber);
  Serial.print(" is now ");
  Serial.println(turnOn ? "ON" : "OFF");
}

// =====================================
// 13. ACKNOWLEDGE COMMAND EXECUTION
// =====================================

bool acknowledgeCommand(
  const String& commandId,
  bool success,
  const String& errorMessage
) {
  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(512, 512);

  HTTPClient http;

  String url = String(API_BASE) +
               "/api/controllers/" +
               CONTROLLER_ID +
               "/commands/" +
               commandId +
               "/ack/";

  if (!http.begin(client, url)) {
    Serial.println("Could not start acknowledgment request.");
    return false;
  }

  http.setTimeout(30000);
  http.addHeader("Authorization",
                 String("Bearer ") + DEVICE_API_KEY);
  http.addHeader("Content-Type", "application/json");

  JsonDocument doc;
  doc["success"] = success;

  if (success) {
    doc["result"] = "GPIO command applied";
  } else {
    doc["error"] = errorMessage;
  }

  String body;
  serializeJson(doc, body);

  int responseCode = http.POST(body);

  bool accepted = (responseCode >= 200 && responseCode < 300);
  if (accepted) {
    Serial.println("Command acknowledgment accepted.");
  } else {
    // -1 is HTTPC_ERROR_CONNECTION_REFUSED, usually the leftover TLS context
    // from the poll. The main loop retries until it is accepted.
    Serial.print("Acknowledgment failed. HTTP: ");
    Serial.println(responseCode);
    Serial.print("Free heap: ");
    Serial.println(ESP.getFreeHeap());
  }

  http.end();
  client.stop();
  return accepted;
}

// =====================================
// 14. SEND HEARTBEAT & VERIFY DATABASE
// =====================================

void sendHeartbeat() {
  Serial.println("Sending heartbeat...");

  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(512, 512);

  HTTPClient http;

  String url = String(API_BASE) +
               "/api/controllers/heartbeat/";

  if (!http.begin(client, url)) {
    Serial.println("Could not start heartbeat request.");
    return;
  }

  http.setTimeout(30000);
  http.addHeader("Authorization",
                 String("Bearer ") + DEVICE_API_KEY);
  http.addHeader("Content-Type", "application/json");

  JsonDocument doc;
  doc["controller_id"] = CONTROLLER_ID;
  doc["ip_address"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["fw"] = "1.0.0";

  String body;
  serializeJson(doc, body);

  int responseCode = http.POST(body);

  bool heartbeatOK = false;
  if (responseCode >= 200 && responseCode < 300) {
    String response = http.getString();

    JsonDocument responseDoc;
    DeserializationError error = deserializeJson(responseDoc, response);

    if (!error &&
        responseDoc["ok"] == true &&
        responseDoc["database_connected"] == true) {
      heartbeatOK = true;
    }
  }

  if (heartbeatOK) {
    lastHeartbeatSuccessMillis = millis();
    heartbeatEverSucceeded = true;
    Serial.println("Heartbeat successful and database verified.");
  } else {
    Serial.print("Heartbeat failed or database check failed. HTTP: ");
    Serial.println(responseCode);
  }

  http.end();
  client.stop();
}

// =====================================
// 15. UPDATE SYSTEM INDICATOR LED (D8)
// =====================================

void updateSystemIndicator() {
  unsigned long now = millis();

  // Fast blink: Wi-Fi disconnected (200ms interval)
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastIndicatorUpdateMillis >= 200) {
      lastIndicatorUpdateMillis = now;
      indicatorLedState = !indicatorLedState;

      digitalWrite(
        SYSTEM_LED_PIN,
        indicatorLedState
          ? (LED_ACTIVE_HIGH ? HIGH : LOW)
          : (LED_ACTIVE_HIGH ? LOW : HIGH)
      );
    }
    return;
  }

  // Slow blink: Wi-Fi connected, but database heartbeat has not been confirmed recently (1000ms interval)
  bool heartbeatHealthy =
    heartbeatEverSucceeded &&
    (now - lastHeartbeatSuccessMillis <= HEARTBEAT_TIMEOUT);

  if (!heartbeatHealthy) {
    if (now - lastIndicatorUpdateMillis >= 1000) {
      lastIndicatorUpdateMillis = now;
      indicatorLedState = !indicatorLedState;

      digitalWrite(
        SYSTEM_LED_PIN,
        indicatorLedState
          ? (LED_ACTIVE_HIGH ? HIGH : LOW)
          : (LED_ACTIVE_HIGH ? LOW : HIGH)
      );
    }
    return;
  }

  // Solid ON: Wi-Fi and recent backend/database heartbeat OK
  indicatorLedState = true;
  digitalWrite(
    SYSTEM_LED_PIN,
    LED_ACTIVE_HIGH ? HIGH : LOW
  );
}
