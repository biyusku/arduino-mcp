/**
 * Starter sketches for create_sketch.
 */

export const TEMPLATE_NAMES = ["blink", "wifi", "mqtt", "sensor", "servo", "i2c_scan", "empty"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

const WIFI_INCLUDE = `#if defined(ESP8266)
  #include <ESP8266WiFi.h>
#else
  #include <WiFi.h>
#endif`;

export function renderTemplate(template: TemplateName, name: string): string {
  switch (template) {
    case "empty":
      return `// ${name}

void setup() {
}

void loop() {
}
`;

    case "blink":
      return `// ${name} — Blink
// Works on: Uno, Mega, Nano (pin 13), most ESP32 boards (pin 2)
#ifndef LED_BUILTIN
  #define LED_BUILTIN 2
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("${name} started!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

    case "wifi":
      return `// ${name} — WiFi Connect (ESP32 / ESP8266 / Pico W)
${WIFI_INCLUDE}

const char* ssid     = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected! IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  delay(1000);
}
`;

    case "mqtt":
      return `// ${name} — MQTT (ESP32 / ESP8266)
// Requires library: PubSubClient
${WIFI_INCLUDE}
#include <PubSubClient.h>

const char* ssid        = "YOUR_SSID";
const char* password    = "YOUR_PASSWORD";
const char* mqtt_server = "broker.hivemq.com";
const char* topic_in    = "devices/${name}/cmd";
const char* topic_out   = "devices/${name}/data";

WiFiClient   espClient;
PubSubClient client(espClient);

void callback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.println("MSG [" + String(topic) + "]: " + msg);
}

void reconnect() {
  while (!client.connected()) {
    String clientId = "${name}-" + String(random(0xffff), HEX);
    if (client.connect(clientId.c_str())) {
      client.subscribe(topic_in);
      Serial.println("MQTT connected");
    } else {
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  Serial.print("IP: "); Serial.println(WiFi.localIP());
  client.setServer(mqtt_server, 1883);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();
  static unsigned long last = 0;
  if (millis() - last > 5000) {
    last = millis();
    client.publish(topic_out, String(millis()).c_str());
  }
}
`;

    case "sensor":
      return `// ${name} — Analog Sensor Read
// Works on: Uno (A0-A5), ESP32 (GPIO 34, 35, 36, 39)
#ifdef ESP32
  #define SENSOR_PIN 34
#else
  #define SENSOR_PIN A0
#endif

void setup() {
  Serial.begin(115200);
  Serial.println("Sensor ready");
}

void loop() {
  int raw = analogRead(SENSOR_PIN);
  #ifdef ESP32
    float v = raw * (3.3f / 4095.0f);
  #else
    float v = raw * (5.0f / 1023.0f);
  #endif
  Serial.print("Raw: "); Serial.print(raw);
  Serial.print("  V: "); Serial.println(v, 2);
  delay(1000);
}
`;

    case "servo":
      return `// ${name} — Servo Control
// Requires library: "Servo" (AVR/SAMD/RP2040) or "ESP32Servo" (ESP32)
#ifdef ESP32
  #include <ESP32Servo.h>
  const int SERVO_PIN = 13;  // any PWM-capable GPIO
#else
  #include <Servo.h>
  const int SERVO_PIN = 9;
#endif

Servo myServo;

void setup() {
  Serial.begin(115200);
  myServo.attach(SERVO_PIN);
  Serial.println("Servo ready. Send 0-180 via Serial.");
}

void loop() {
  if (!Serial.available()) return;
  // Read a whole line: parseInt() would turn the trailing newline into a 0.
  String line = Serial.readStringUntil('\\n');
  line.trim();
  if (line.length() == 0) return;
  int angle = line.toInt();
  if ((angle == 0 && line != "0") || angle < 0 || angle > 180) {
    Serial.println("Send a number from 0 to 180.");
    return;
  }
  myServo.write(angle);
  Serial.print("Angle: "); Serial.println(angle);
}
`;

    case "i2c_scan":
      return `// ${name} — I2C Scanner
// Finds all I2C devices on the bus
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Serial.println("I2C Scanner started");

  byte count = 0;
  for (byte addr = 8; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("Found device at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      count++;
    }
  }
  Serial.print("Total devices: "); Serial.println(count);
}

void loop() {}
`;
  }
}
