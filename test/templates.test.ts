/**
 * Every create_sketch template must at least be valid C++ against the
 * Arduino API (checked with g++ and small stub headers, for AVR-, ESP32- and
 * ESP8266-style builds).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { commandExists, run } from "../src/lib/exec.js";
import { renderTemplate, TEMPLATE_NAMES } from "../src/templates.js";
import { ROOT } from "./helpers.js";

const STUBS = path.join(ROOT, "test", "fixtures", "arduino-stubs");
const hasGpp = commandExists("g++");

for (const name of TEMPLATE_NAMES) {
  test(`template "${name}" compiles (syntax) for AVR, ESP32 and ESP8266`, { skip: !hasGpp && "g++ not installed" }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-tmpl-"));
    const file = path.join(dir, `${name}.cpp`);
    fs.writeFileSync(file, `#include <Arduino.h>\n${renderTemplate(name, `my_${name}`)}`);
    for (const defines of [[], ["-DESP32"], ["-DESP8266"]]) {
      const r = await run("g++", ["-std=gnu++17", "-fsyntax-only", "-Werror=narrowing", `-I${STUBS}`, ...defines, file]);
      assert.equal(r.ok, true, `${name} ${defines.join(" ")}:\n${r.output}`);
    }
  });
}
