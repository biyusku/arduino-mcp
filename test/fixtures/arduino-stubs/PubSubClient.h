#pragma once
#include <Arduino.h>
class Client;
class PubSubClient {
 public:
  template <class C> explicit PubSubClient(C&) {}
  bool connected() { return false; }
  bool connect(const char*) { return false; }
  bool subscribe(const char*) { return false; }
  bool publish(const char*, const char*) { return false; }
  void setServer(const char*, uint16_t) {}
  void setCallback(void (*)(char*, uint8_t*, unsigned int)) {}
  bool loop() { return false; }
};
