import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePorts, parseBoardListJson, pickPorts, roleForVendor } from "../src/lib/ports.js";

const CLI_JSON = JSON.stringify({
  detected_ports: [
    {
      matching_boards: [{ name: "ESP32S3 Dev Module", fqbn: "esp32:esp32:esp32s3" }, { name: "Other S3", fqbn: "esp32:esp32:other" }],
      port: {
        address: "/dev/ttyACM0", label: "/dev/ttyACM0", protocol: "serial", protocol_label: "Serial Port (USB)",
        properties: { pid: "0x1001", serialNumber: "E8:F6:0A", vid: "0x303A" },
      },
    },
    {
      port: {
        address: "/dev/ttyACM1", label: "/dev/ttyACM1", protocol: "serial",
        properties: { pid: "0x55D3", serialNumber: "5A7B", vid: "0x1A86" },
      },
    },
    { port: { address: "192.168.1.9", protocol: "network", label: "esp32 at 192.168.1.9" } },
    { port: { address: "/dev/ttyS0", protocol: "serial", label: "/dev/ttyS0" } },
  ],
});

test("parses arduino-cli >= 1.0 JSON", () => {
  const ports = parseBoardListJson(CLI_JSON);
  assert.equal(ports.length, 4);
  assert.deepEqual(ports[0], {
    address: "/dev/ttyACM0", protocol: "serial", label: "/dev/ttyACM0", vid: "303a", pid: "1001", serial: "E8:F6:0A",
    boards: [{ name: "ESP32S3 Dev Module", fqbn: "esp32:esp32:esp32s3" }, { name: "Other S3", fqbn: "esp32:esp32:other" }],
  });
});

test("parses the pre-1.0 array format and survives garbage", () => {
  const old = JSON.stringify([{ port: { address: "COM3", protocol: "serial", properties: { vid: "0x2341", pid: "0x0043" } }, matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }] }]);
  assert.deepEqual(parseBoardListJson(old)[0].boards, [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }]);
  assert.deepEqual(parseBoardListJson("not json"), []);
  assert.deepEqual(parseBoardListJson("{}"), []);
});

test("vendor roles", () => {
  assert.equal(roleForVendor("1a86"), "upload");
  assert.equal(roleForVendor("303a"), "monitor");
  assert.equal(roleForVendor("2341"), "both");
  assert.equal(roleForVendor("10c4"), "both");
});

test("ESP32-S3 dual USB: CH343 for upload, native USB for monitor", () => {
  const merged = mergePorts([], parseBoardListJson(CLI_JSON));
  assert.deepEqual(merged.map((p) => p.port), ["/dev/ttyACM0", "/dev/ttyACM1"]); // network + ttyS0 dropped
  const pick = pickPorts(merged)!;
  assert.equal(pick.uploadPort, "/dev/ttyACM1");
  assert.equal(pick.monitorPort, "/dev/ttyACM0");
  assert.equal(pick.fqbn, "esp32:esp32:esp32s3");
  assert.equal(pick.boardName, "ESP32S3 Dev Module");
  assert.deepEqual(pick.alternatives.map((b) => b.fqbn), ["esp32:esp32:other"]);
});

test("OS info and arduino-cli info are merged by port", () => {
  const merged = mergePorts(
    [{ path: "/dev/ttyACM0", vendor: "2341", product: "0043", serial: "", manufacturer: "Arduino (www.arduino.cc)" }],
    parseBoardListJson(JSON.stringify({ detected_ports: [{ port: { address: "/dev/ttyACM0", protocol: "serial", properties: { serialNumber: "85735313" } }, matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }] }] }))
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].serial, "85735313");
  assert.equal(merged[0].description, "Arduino (www.arduino.cc)");
  const pick = pickPorts(merged)!;
  assert.equal(pick.uploadPort, "/dev/ttyACM0");
  assert.equal(pick.monitorPort, "/dev/ttyACM0");
  assert.equal(pick.fqbn, "arduino:avr:uno");
});

test("single CH340 clone uses the same port for both", () => {
  const pick = pickPorts(mergePorts([{ path: "/dev/ttyUSB0", vendor: "1a86", product: "7523", serial: "", manufacturer: "" }], []))!;
  assert.equal(pick.uploadPort, "/dev/ttyUSB0");
  assert.equal(pick.monitorPort, "/dev/ttyUSB0");
  assert.equal(pick.fqbn, undefined);
  assert.equal(pick.serial, "1a86:7523");
});

test("no ports → null", () => {
  assert.equal(pickPorts([]), null);
});
