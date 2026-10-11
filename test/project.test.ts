import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// project.ts reads ARDUINO_SKETCHES_DIR at import time
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-proj-"));
process.env.ARDUINO_SKETCHES_DIR = path.join(tmp, "sketches");
const project = await import("../src/project.js");
const { UserError } = await import("../src/lib/validate.js");

test("YAML round trip keeps special characters, lists and numbers", async () => {
  const cfg = {
    name: "weather",
    description: "Weather: station #1 | outdoor",
    version: "1.0.0",
    fqbn: "esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi",
    upload_port: "/dev/ttyACM1",
    baud: 115200,
    libraries: ["DHT sensor library", "Adafruit Unified Sensor"],
    build_flags: ["-DDEBUG=1", "-DNAME=\"x y\""],
  };
  const file = await project.writeProjectConfig("weather", cfg);
  assert.ok(fs.readFileSync(file, "utf-8").startsWith("# arduino-mcp project config\n"));
  assert.deepEqual(await project.readProjectConfig("weather"), { ...cfg, monitor_port: undefined });
});

test("reads hand-written YAML, including inline lists and comments", async () => {
  const dir = path.join(tmp, "sketches", "hand");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "arduino-mcp.yaml"), "fqbn: arduino:avr:uno # the board\nbaud: 9600\nlibraries: [Servo, \"FastLED\"]\n");
  const cfg = await project.readProjectConfig("hand");
  assert.equal(cfg?.fqbn, "arduino:avr:uno");
  assert.equal(cfg?.baud, 9600);
  assert.deepEqual(cfg?.libraries, ["Servo", "FastLED"]);
});

test("invalid YAML is reported", async () => {
  const dir = path.join(tmp, "sketches", "bad");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "arduino-mcp.yaml"), "libraries: [unclosed\n");
  await assert.rejects(project.readProjectConfig("bad"), UserError);
});

test("multi-file sketches: src/ subfolder is listed, traversal is refused", async () => {
  await project.writeProjectFile("multi", "multi.ino", "void setup(){}\nvoid loop(){}\n");
  await project.writeProjectFile("multi", "sensors.h", "#pragma once\n");
  await project.writeProjectFile("multi", "src/drivers/motor.cpp", "// motor\n");
  assert.deepEqual(await project.listProjectFiles("multi"), ["multi.ino", "sensors.h", "src/drivers/motor.cpp"]);
  assert.equal(await project.readProjectFile("multi", "src/drivers/motor.cpp"), "// motor\n");

  await assert.rejects(project.writeProjectFile("multi", "../../escaped.txt", "x"), UserError);
  await assert.rejects(project.readProjectFile("multi", "../../../etc/passwd"), UserError);
  await assert.rejects(project.writeProjectFile("..", "x.h", "x"), UserError);
  assert.equal(fs.existsSync(path.join(tmp, "escaped.txt")), false);
});
