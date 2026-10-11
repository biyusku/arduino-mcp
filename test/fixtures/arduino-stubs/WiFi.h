#pragma once
#include <Arduino.h>
enum { WL_CONNECTED = 3 };
struct IPAddress {};
struct WiFiClass {
  int begin(const char*, const char*) { return 0; }
  int status() { return 0; }
  IPAddress localIP() { return IPAddress(); }
};
extern WiFiClass WiFi;
class WiFiClient {};
