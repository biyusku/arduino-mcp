import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  applyBoardOptions, buildFqbn, getPlatformFamily, loadConfig, mergeOptions, renameWithRetry, saveConfig, setBoardOption, splitFqbn,
  updateConfig,
  type BoardConfig,
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

test("parallel saves and updates neither fail nor lose changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-cfg-"));
  const file = path.join(dir, "cfg.json");

  const saves = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => saveConfig({ boards: { [`S${i}`]: board({ fqbn: "arduino:avr:uno" }) } }, file))
  );
  assert.deepEqual(saves.filter((r) => r.status === "rejected"), []);

  await Promise.all(Array.from({ length: 20 }, (_, i) => updateConfig((cfg) => {
    cfg.boards[`B${i}`] = board({ fqbn: "arduino:avr:uno", family: "avr" });
  }, file)));
  const cfg = await loadConfig(file);
  for (let i = 0; i < 20; i++) assert.ok(cfg.boards[`B${i}`], `B${i} lost`);
  assert.deepEqual(fs.readdirSync(dir), ["cfg.json"]);
});

test("updateConfig saves nothing when the change throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-cfg-"));
  const file = path.join(dir, "cfg.json");
  await saveConfig({ boards: {} }, file);
  await assert.rejects(updateConfig((cfg) => {
    cfg.boards.X = board({});
    throw new UserError("nope");
  }, file), /nope/);
  assert.deepEqual(await loadConfig(file), { boards: {} });
  await updateConfig((cfg) => { cfg.defaultBoard = "after-error"; }, file); // queue still works
  assert.equal((await loadConfig(file)).defaultBoard, "after-error");
});

test("menu options go to their own field; clearing a field clears the FQBN option", () => {
  const b = board({ fqbn: "esp32:esp32:esp32s3", family: "esp32" });
  applyBoardOptions(b, "PSRAM=opi,DebugLevel=info");
  assert.equal(b.psram, "opi");
  assert.equal(b.extraOptions, "DebugLevel=info");
  setBoardOption(b, "psram", undefined);
  assert.equal(buildFqbn(b), "esp32:esp32:esp32s3:DebugLevel=info");

  const nano = board({ fqbn: "arduino:avr:nano", family: "avr" });
  applyBoardOptions(nano, "cpu=atmega328old");
  assert.equal(nano.extraOptions, "cpu=atmega328old");
  assert.equal(buildFqbn(nano), "arduino:avr:nano:cpu=atmega328old");
});

test("v3 'cpu speed' (uploadSpeed on AVR) becomes cpu=...; v4.0.0 options in extraOptions move to fields", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-cfg-"));
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, JSON.stringify({
    boards: {
      nano: { fqbn: "arduino:avr:nano", family: "avr", uploadPort: "", monitorPort: "", uploadSpeed: "atmega328old", lastSeen: "" },
      nano2: { fqbn: "arduino:avr:nano", family: "avr", uploadPort: "", monitorPort: "", uploadSpeed: "atmega328old", extraOptions: "cpu=atmega328", lastSeen: "" },
      s3: { fqbn: "esp32:esp32:esp32s3", family: "esp32", uploadPort: "", monitorPort: "", psram: "disabled", extraOptions: "PSRAM=opi,DebugLevel=info", lastSeen: "" },
    },
  }));
  const cfg = await loadConfig(file);
  assert.equal(buildFqbn(cfg.boards.nano), "arduino:avr:nano:cpu=atmega328old");
  assert.equal(cfg.boards.nano.uploadSpeed, undefined);
  assert.equal(buildFqbn(cfg.boards.nano2), "arduino:avr:nano:cpu=atmega328"); // explicit option wins
  assert.equal(cfg.boards.s3.psram, "opi"); // same effective FQBN as before
  assert.equal(cfg.boards.s3.extraOptions, "DebugLevel=info");
  assert.equal(buildFqbn(cfg.boards.s3), "esp32:esp32:esp32s3:PSRAM=opi,DebugLevel=info");
});

test("renameWithRetry retries Windows sharing errors, nothing else", async () => {
  const failing = (codes: string[]) => {
    let calls = 0;
    const rename = async () => {
      const code = codes[calls++];
      if (code) throw Object.assign(new Error(code), { code });
    };
    return { rename, calls: () => calls };
  };
  const win = failing(["EPERM", "EBUSY"]);
  await renameWithRetry("a", "b", win.rename, "win32");
  assert.equal(win.calls(), 3);

  const posix = failing(["EPERM"]);
  await assert.rejects(renameWithRetry("a", "b", posix.rename, "linux"), /EPERM/);
  assert.equal(posix.calls(), 1);

  const other = failing(["ENOENT"]);
  await assert.rejects(renameWithRetry("a", "b", other.rename, "win32"), /ENOENT/);
});

