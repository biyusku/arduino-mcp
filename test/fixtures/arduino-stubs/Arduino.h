// Minimal Arduino API stubs: just enough for `g++ -fsyntax-only` on the
// create_sketch templates (test/templates.test.ts). Not a real implementation.
#pragma once
#include <stdint.h>
#include <string>
typedef uint8_t byte;
enum { LOW = 0, HIGH = 1, INPUT = 0, OUTPUT = 1, HEX = 16, DEC = 10, A0 = 14 };
#ifndef ESP32
#define LED_BUILTIN 13
#endif
class String {
 public:
  std::string s;
  String(const char* c = "") : s(c) {}
  String(char c) : s(1, c) {}
  String(int v, int base = DEC) : s(std::to_string(v)) { (void)base; }
  String(long v, int base = DEC) : s(std::to_string(v)) { (void)base; }
  String(unsigned long v, int base = DEC) : s(std::to_string(v)) { (void)base; }
  const char* c_str() const { return s.c_str(); }
  unsigned length() const { return s.size(); }
  void trim() {}
  long toInt() const { return 0; }
  String& operator+=(char c) { s += c; return *this; }
  String& operator+=(const String& o) { s += o.s; return *this; }
  bool operator==(const char* c) const { return s == c; }
  bool operator!=(const char* c) const { return s != c; }
};
inline String operator+(const String& a, const String& b) { return String((a.s + b.s).c_str()); }
inline String operator+(const char* a, const String& b) { return String(a) + b; }
inline String operator+(const String& a, const char* b) { return a + String(b); }
class Print {
 public:
  template <class T> void print(T) {}
  template <class T> void print(T, int) {}
  template <class T> void println(T) {}
  template <class T> void println(T, int) {}
  void println() {}
};
class HardwareSerial : public Print {
 public:
  void begin(unsigned long) {}
  int available() { return 0; }
  int read() { return -1; }
  long parseInt() { return 0; }
  String readStringUntil(char) { return String(); }
};
extern HardwareSerial Serial;
void pinMode(uint8_t, uint8_t);
void digitalWrite(uint8_t, uint8_t);
int analogRead(uint8_t);
void delay(unsigned long);
unsigned long millis();
long random(long);
