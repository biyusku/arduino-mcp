import assert from "node:assert/strict";
import { test } from "node:test";
import { compileArgs, formatCompileResult, parseCompileErrors, type Target } from "../src/lib/arduino.js";

test("parses errors with and without column, including fatal errors", () => {
  const out = [
    "/home/u/Arduino/x/x.ino:12:5: error: 'foo' was not declared in this scope",
    "/home/u/Arduino/x/x.ino:3:10: fatal error: DHT.h: No such file or directory",
    "/home/u/Arduino/x/util.cpp:7: error: expected ';' before '}' token",
    "/home/u/Arduino/x/x.ino:20:1: warning: unused variable 'a'",
  ].join("\n");
  assert.deepEqual(parseCompileErrors(out), [
    { file: "x.ino", line: 12, col: 5, message: "'foo' was not declared in this scope" },
    { file: "x.ino", line: 3, col: 10, message: "DHT.h: No such file or directory" },
    { file: "util.cpp", line: 7, col: 0, message: "expected ';' before '}' token" },
  ]);
});

test("success shows flash and RAM usage", () => {
  const out = "Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.\n" +
    "Global variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.";
  const text = formatCompileResult(true, out, "arduino:avr:uno");
  assert.match(text, /Compile succeeded \(arduino:avr:uno\)/);
  assert.match(text, /Sketch uses 924 bytes/);
  assert.match(text, /Global variables use 9 bytes/);
});

test("linker errors are shown", () => {
  const out = "/tmp/ccX.ltrans0.ltrans.o: In function `loop':\nx.ino:5: undefined reference to `missing()'\ncollect2: error: ld returned 1 exit status";
  const text = formatCompileResult(false, out, "arduino:avr:uno");
  assert.match(text, /undefined reference to `missing\(\)'/);
  assert.match(text, /ld returned 1 exit status/);
});

test("unparseable failure falls back to raw output", () => {
  const text = formatCompileResult(false, "Error during build: Platform 'esp32:esp32' not found", "esp32:esp32:esp32");
  assert.match(text, /Platform 'esp32:esp32' not found/);
});

test("build flags become compiler extra_flags properties", () => {
  const t: Target = { dir: "/s/x", fqbn: "arduino:avr:uno", family: "avr", buildFlags: ["-DDEBUG=1", "-O2"], board: null };
  assert.deepEqual(compileArgs(t), [
    "compile", "--fqbn", "arduino:avr:uno",
    "--build-property", "compiler.cpp.extra_flags=-DDEBUG=1 -O2",
    "--build-property", "compiler.c.extra_flags=-DDEBUG=1 -O2",
    "/s/x",
  ]);
  assert.deepEqual(compileArgs({ ...t, buildFlags: [] }, true), ["compile", "--fqbn", "arduino:avr:uno", "--verbose", "/s/x"]);
});
