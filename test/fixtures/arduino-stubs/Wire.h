#pragma once
#include <Arduino.h>
struct TwoWire {
  void begin() {}
  void beginTransmission(uint8_t) {}
  uint8_t endTransmission() { return 0; }
};
extern TwoWire Wire;
