import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildFqbn, getPlatformFamily, loadConfig, mergeOptions, saveConfig, splitFqbn, type BoardConfig,
} from "../src/lib/config.js";
import { UserError } from "../src/lib/validate.js";

const board = (b: Partial<BoardConfig>): BoardConfig => ({
  fqbn: "", family: "unknown", uploadPort: "", monitorPort: "", lastSeen: "", ...b,
});

test("AVR: upload speed is not turned into an invalid cpu= option", () => {
  assert.equal(buildFqbn(board({ fqbn: "arduino:avr:uno", family: "avr", uploadSpeed: "115200" })), "arduino:avr:uno");
});

test("AVR: extra options are passed through", () => {
  assert.equal(
    buildFqbn(board({ fqbn: "arduino:avr:nano", family: "avr", extraOptions: "cpu=atmega328old" })),
    "arduino:avr:nano:cpu=atmega328old"
  );
});

test("ESP32 options, extra options override", () => {
  assert.equal(
    buildFqbn(board({
      fqbn: "esp32:esp32:esp32s3", family: "esp32", cdcOnBoot: "cdc", flashSize: "16M", psram: "opi",
      uploadSpeed: "921600", extraOptions: "PSRAM=disabled,DebugLevel=info",
    })),
    "esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=16M,PSRAM=disabled,UploadSpeed=921600,DebugLevel=info"
  );
});

test("ESP8266 upload speed uses the baud menu", () => {
  assert.equal(buildFqbn(board({ fqbn: "esp8266:esp8266:nodemcuv2", family: "esp8266", uploadSpeed: "921600" })), "esp8266:esp8266:nodemcuv2:baud=921600");
});

test("unknown board gives empty FQBN", () => {
  assert.equal(buildFqbn(board({})), "");
});

test("platform families", () => {
  assert.equal(getPlatformFamily("arduino:avr:uno"), "avr");
  assert.equal(getPlatformFamily("arduino:megaavr:nona4809"), "avr");
  assert.equal(getPlatformFamily("esp32:esp32:esp32s3"), "esp32");
  assert.equal(getPlatformFamily("esp8266:esp8266:d1_mini"), "esp8266");
  assert.equal(getPlatformFamily("rp2040:rp2040:rpipico"), "rp2040");
  assert.equal(getPlatformFamily("arduino:mbed_rp2040:pico"), "rp2040");
  assert.equal(getPlatformFamily("STMicroelectronics:stm32:Nucleo_64"), "stm32");
  assert.equal(getPlatformFamily(""), "unknown");
});

test("splitFqbn / mergeOptions", () => {
  assert.deepEqual(splitFqbn("esp32:esp32:esp32s3:PSRAM=opi"), { base: "esp32:esp32:esp32s3", options: "PSRAM=opi" });
  assert.deepEqual(splitFqbn("arduino:avr:uno"), { base: "arduino:avr:uno", options: "" });
  assert.equal(mergeOptions("a=1,b=2", "b=3,c=4"), "a=1,b=3,c=4");
  assert.equal(mergeOptions(undefined, ""), undefined);
});

test("config file: missing → empty, round trip, corrupt → error (never silently reset)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-cfg-"));
  const file = path.join(dir, "cfg.json");
  assert.deepEqual(await loadConfig(file), { boards: {} });

  const cfg = { boards: { X: board({ fqbn: "arduino:avr:uno", family: "avr" }) }, defaultBoard: "X" };
  await saveConfig(cfg, file);
  assert.deepEqual(await loadConfig(file), cfg);
  assert.deepEqual(fs.readdirSync(dir), ["cfg.json"]); // no temp files left behind

  fs.writeFileSync(file, "{ not json");
  await assert.rejects(loadConfig(file), UserError);
  assert.equal(fs.readFileSync(file, "utf-8"), "{ not json");
});

test("config written by v3 is upgraded: family recomputed, broken AVR cpu= option gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-cfg-"));
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, JSON.stringify({
    defaultBoard: "A",
    boards: {
      A: { fqbn: "arduino:avr:uno", family: "avr", uploadPort: "/dev/ttyACM0", monitorPort: "/dev/ttyACM0", uploadSpeed: "115200", lastSeen: "" },
      B: { fqbn: "esp8266:esp8266:d1_mini", family: "unknown", uploadPort: "/dev/ttyUSB0", monitorPort: "/dev/ttyUSB0", uploadSpeed: "921600", lastSeen: "" },
    },
  }));
  const cfg = await loadConfig(file);
  assert.equal(buildFqbn(cfg.boards.A), "arduino:avr:uno");
  assert.equal(cfg.boards.B.family, "esp8266");
  assert.equal(buildFqbn(cfg.boards.B), "esp8266:esp8266:d1_mini:baud=921600");
});
