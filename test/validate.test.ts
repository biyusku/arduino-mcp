import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  assertBuildFlags, assertFqbn, assertHost, assertHttpUrl, assertLibraryName, assertPlatformId, assertSerialPort, assertSketchName,
  parseBoardOptions, pathsBelow, resolveInside, sketchDir, UserError,
} from "../src/lib/validate.js";

test("sketch names: valid", () => {
  for (const name of ["blink", "Blink_2", "my-sketch", "v1.2", "a"]) assert.equal(assertSketchName(name), name);
});

test("sketch names: path traversal and junk are rejected", () => {
  for (const name of ["", ".", "..", "../x", "a/b", "a\\b", "/etc", "-x", "_x", "x".repeat(64), "a b", 'a"b']) {
    assert.throws(() => assertSketchName(name), UserError, name);
  }
});

test("sketchDir never leaves the base directory", () => {
  const base = path.resolve("/tmp/sketches");
  assert.equal(sketchDir("blink", base), path.join(base, "blink"));
  assert.throws(() => sketchDir("..", base), UserError);
  assert.throws(() => sketchDir("", base), UserError);
});

test("resolveInside allows nested files", () => {
  const base = path.resolve("/tmp/sk/blink");
  assert.equal(resolveInside(base, "sensors.h"), path.join(base, "sensors.h"));
  assert.equal(resolveInside(base, "src/utils.cpp"), path.join(base, "src", "utils.cpp"));
  assert.equal(resolveInside(base, "..foo.h"), path.join(base, "..foo.h"));
});

test("resolveInside rejects escapes", () => {
  const base = path.resolve("/tmp/sk/blink");
  for (const p of ["", ".", "..", "../x.h", "../../.bashrc", "src/../../x", "/etc/passwd", "C:\\x"]) {
    assert.throws(() => resolveInside(base, p), UserError, p);
  }
});

test("serial ports", () => {
  for (const p of ["/dev/ttyACM0", "/dev/ttyUSB1", "/dev/cu.usbmodem1101", "/dev/serial/by-id/usb-1a86_USB_Single-if00", "/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0", "/dev/pts/3", "COM3", "\\\\.\\COM12"]) {
    assert.equal(assertSerialPort(p), p);
  }
  for (const p of ["", "ttyACM0", "/dev/../home/me/.bashrc", "/dev/tty; rm -rf ~", "/home/me/file", "-p", "$(id)"]) {
    assert.throws(() => assertSerialPort(p), UserError, p);
  }
});

test("FQBNs", () => {
  for (const f of ["arduino:avr:uno", "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M", "arduino:avr:nano:cpu=atmega328old"]) {
    assert.equal(assertFqbn(f), f);
  }
  for (const f of ["", "uno", "arduino:avr", "arduino:avr:uno:", "arduino:avr:uno:cpu", 'a:b:c" && id', "a:b:c:k=v;id"]) {
    assert.throws(() => assertFqbn(f), UserError, f);
  }
});

test("board options", () => {
  assert.deepEqual(parseBoardOptions("cpu=atmega328old, baud=115200"), [["cpu", "atmega328old"], ["baud", "115200"]]);
  assert.deepEqual(parseBoardOptions(""), []);
  assert.throws(() => parseBoardOptions("cpu"), UserError);
  assert.throws(() => parseBoardOptions("cpu=a b"), UserError);
});

test("hosts, URLs, libraries, platforms", () => {
  assert.equal(assertHost("192.168.1.20"), "192.168.1.20");
  assert.equal(assertHost("esp32-ota.local"), "esp32-ota.local");
  assert.throws(() => assertHost("--help"), UserError);
  assert.throws(() => assertHost("1.2.3.4 && id"), UserError);

  assert.equal(assertHttpUrl("https://example.com/index.json"), "https://example.com/index.json");
  assert.throws(() => assertHttpUrl("file:///etc/passwd"), UserError);
  assert.throws(() => assertHttpUrl("not a url"), UserError);

  assert.equal(assertLibraryName("DHT sensor library"), "DHT sensor library");
  assert.throws(() => assertLibraryName("--git-url"), UserError);
  assert.throws(() => assertLibraryName("a\nb"), UserError);

  assert.equal(assertPlatformId("esp32:esp32"), "esp32:esp32");
  assert.equal(assertPlatformId("arduino:avr@1.8.6"), "arduino:avr@1.8.6");
  assert.throws(() => assertPlatformId("esp32"), UserError);
});

test("build flags: harmless flags pass", () => {
  const ok = ["-DDEBUG", "-DDEBUG=1", "-DPIN=GPIO_NUM_4", "-DVER=1.2.3", "-UNDEBUG", "-O2", "-Os", "-O", "-g", "-g3",
    "-std=gnu++17", "-Wall", "-Werror", "-Wno-unused-variable", "-fpermissive", "-fno-exceptions", "-fmax-errors=5", "-mlongcalls", "-mcpu=cortex-m0plus"];
  assert.deepEqual(assertBuildFlags(ok), ok);
});

test("build flags: anything that can run code or read files is refused", () => {
  for (const flag of [
    "-wrapper", "/bin/sh,-c,id", "@/home/u/.ssh/id_rsa", "-fplugin=/tmp/evil.so", "-Wl,-plugin=/tmp/evil.so", "-Wa,--foo", "-Wp,-x",
    "-B/tmp", "-include", "/etc/passwd", "-I/home/u/.ssh", "-specs=/tmp/x", "-DX -fplugin=/tmp/e.so", '-DX="a" -fplugin=e', "-DX=a\\b", "",
  ]) {
    assert.throws(() => assertBuildFlags([flag]), UserError, flag);
  }
});

test("pathsBelow walks down from the base, also when Windows casing differs", () => {
  assert.deepEqual(pathsBelow("/a/sk", "/a/sk/src/x.h", path.posix), ["/a/sk/src", "/a/sk/src/x.h"]);
  const base = "C:\\Users\\me\\Arduino\\blink";
  const target = path.win32.resolve(base, "..\\Blink\\blink.ino"); // same folder, other case
  assert.deepEqual(pathsBelow(base, target, path.win32), ["C:\\Users\\me\\Arduino\\blink\\blink.ino"]);
});

