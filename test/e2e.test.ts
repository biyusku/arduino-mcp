/**
 * End-to-end: starts the real server over stdio and talks to it with the MCP client.
 * arduino-cli is replaced by test/fixtures/fake-arduino-cli.cjs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { cliCalls, connect, makeSandbox, type Sandbox } from "./helpers.js";

// Running a .cjs file directly as a command needs a shebang (not on Windows).
const canRunFakeCli = process.platform !== "win32";

describe("arduino-mcp over stdio", () => {
  let sb: Sandbox;
  let mcp: Awaited<ReturnType<typeof connect>>;

  before(async () => {
    sb = makeSandbox();
    fs.writeFileSync(path.join(sb.home, "precious.txt"), "do not delete");
    mcp = await connect(sb);
  });
  after(async () => {
    await mcp.close();
  });

  test("registers all 42 tools with annotations", async () => {
    const { tools } = await mcp.client.listTools();
    assert.equal(tools.length, 42);
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get("delete_sketch")?.annotations?.destructiveHint, true);
    assert.equal(byName.get("erase_flash")?.annotations?.destructiveHint, true);
    assert.equal(byName.get("list_sketches")?.annotations?.readOnlyHint, true);
    for (const t of tools) assert.ok(t.description && t.description.length > 10, t.name);
  });

  test("server version comes from package.json", async () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(mcp.client.getServerVersion()?.version, pkg.version);
  });

  test("sketch lifecycle", async () => {
    let r = await mcp.call("create_sketch", { name: "blinky", template: "blink" });
    assert.equal(r.isError, false, r.text);
    assert.ok(fs.existsSync(path.join(sb.sketches, "blinky", "blinky.ino")));

    r = await mcp.call("create_sketch", { name: "blinky", template: "empty" });
    assert.equal(r.isError, true);
    assert.match(r.text, /already exists/);

    r = await mcp.call("create_sketch", { name: "custom1", template: "custom" });
    assert.equal(r.isError, true);
    assert.match(r.text, /needs the code parameter/);

    r = await mcp.call("read_sketch", { name: "blinky" });
    assert.match(r.text, /digitalWrite\(LED_BUILTIN, HIGH\)/);

    r = await mcp.call("rename_sketch", { old_name: "blinky", new_name: "blinky2" });
    assert.equal(r.isError, false, r.text);
    assert.ok(fs.existsSync(path.join(sb.sketches, "blinky2", "blinky2.ino")));

    r = await mcp.call("list_sketches");
    assert.match(r.text, /blinky2/);

    r = await mcp.call("delete_sketch", { name: "blinky2" });
    assert.equal(r.isError, false, r.text);
    assert.equal(fs.existsSync(path.join(sb.sketches, "blinky2")), false);
  });

  test("path traversal is refused everywhere", async () => {
    for (const name of ["..", "", "../..", "a/../.."]) {
      const r = await mcp.call("delete_sketch", { name });
      assert.equal(r.isError, true, `delete_sketch ${JSON.stringify(name)}`);
    }
    assert.equal(fs.readFileSync(path.join(sb.home, "precious.txt"), "utf-8"), "do not delete");
    assert.ok(fs.existsSync(sb.sketches));

    await mcp.call("create_sketch", { name: "victim", template: "empty" });
    let r = await mcp.call("project_write_file", { name: "victim", filename: "../../TRAVERSAL.txt", content: "x" });
    assert.equal(r.isError, true);
    assert.equal(fs.existsSync(path.join(sb.home, "TRAVERSAL.txt")), false);

    r = await mcp.call("project_read_file", { name: "victim", filename: "../../precious.txt" });
    assert.equal(r.isError, true);

    r = await mcp.call("write_sketch", { name: "../outside", code: "x" });
    assert.equal(r.isError, true);

    r = await mcp.call("generate_diagram", {
      title: "t", format: "markdown", components: [{ name: "A", type: "sensor", pins: ["1"] }], connections: [], save_to: "..",
    });
    assert.equal(r.isError, true);
  });

  test("sketch files that are symlinks to outside files are refused", { skip: process.platform === "win32" }, async () => {
    const dir = path.join(sb.sketches, "trap");
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(sb.home, "precious.txt"), path.join(dir, "trap.ino"));
    let r = await mcp.call("write_sketch", { name: "trap", code: "overwritten" });
    assert.equal(r.isError, true);
    r = await mcp.call("read_sketch", { name: "trap" });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /do not delete/);
    assert.equal(fs.readFileSync(path.join(sb.home, "precious.txt"), "utf-8"), "do not delete");
  });

  test("quick_diagram keeps names like Button and Motor intact", async () => {
    const r = await mcp.call("quick_diagram", { title: "t", connections_text: "Button OUT -> ESP32 GPIO4\nMotor IN1 -> L298N IN1" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /\| Button OUT \| ESP32 GPIO4 \|/);
    assert.match(r.text, /\| Motor IN1 \| L298N IN1 \|/);
  });

  test("generate_diagram returns the whole SVG when not saving, writes files when saving", async () => {
    const args = { title: "t", format: "svg", components: [{ name: "ESP32", type: "microcontroller", pins: ["GPIO4"] }], connections: [] };
    let r = await mcp.call("generate_diagram", args);
    assert.match(r.text, /<svg[\s\S]*<\/svg>/);

    r = await mcp.call("generate_diagram", { ...args, format: "both", save_to: "newproj" });
    assert.equal(r.isError, false, r.text);
    assert.ok(fs.existsSync(path.join(sb.sketches, "newproj", "wiring.svg")));
    assert.ok(fs.existsSync(path.join(sb.sketches, "newproj", "wiring.md")));
  });

  test("board_config: manual board, AVR options, FQBN with options", async () => {
    let r = await mcp.call("board_config", { action: "show" });
    assert.match(r.text, /No saved board/);

    r = await mcp.call("board_config", { action: "set", fqbn: "arduino:avr:nano:cpu=atmega328old", upload_port: "/dev/ttyUSB0", upload_speed: "115200" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /FQBN: arduino:avr:nano:cpu=atmega328old\n/);

    // switching to another board drops the old board's options (they would make the FQBN invalid)
    r = await mcp.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32s3", psram: "opi", flash_size: "16M" });
    assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi\n/);

    r = await mcp.call("board_config", { action: "set", psram: "", upload_speed: "921600" });
    assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,UploadSpeed=921600\n/);

    r = await mcp.call("board_config", { action: "set", upload_port: "/dev/tty; reboot" });
    assert.equal(r.isError, true);

    r = await mcp.call("board_config", { action: "set", fqbn: "arduino:avr:uno\" && id" });
    assert.equal(r.isError, true);
  });

  test("shell metacharacters reach arduino-cli as plain arguments", { skip: !canRunFakeCli }, async () => {
    const marker = path.join(sb.dir, "INJECTED");
    const payload = `x"; touch ${marker}; echo "`;
    await mcp.call("search_library", { query: payload });
    await mcp.call("install_library", { library: `DHT"; touch ${marker}; "` });
    assert.equal(fs.existsSync(marker), false);
    const calls = cliCalls(sb);
    assert.deepEqual(calls.find((c) => c[1] === "search")?.slice(0, 3), ["lib", "search", "--"]);
    assert.deepEqual(calls.find((c) => c[1] === "install"), ["lib", "install", "--", `DHT"; touch ${marker}; "`]);
  });

  test("compile uses arduino-mcp.yaml (fqbn, build flags) and formats errors", { skip: !canRunFakeCli }, async () => {
    await mcp.call("create_sketch", { name: "proj", template: "blink" });
    let r = await mcp.call("project_init", { name: "proj", fqbn: "arduino:avr:mega", build_flags: ["-DDEBUG=1"], libraries: ["Servo"] });
    assert.equal(r.isError, false, r.text);

    r = await mcp.call("compile_sketch", { name: "proj" });
    assert.match(r.text, /Compile succeeded \(arduino:avr:mega\)/);
    assert.match(r.text, /Global variables use 9 bytes/);
    const call = cliCalls(sb).filter((c) => c[0] === "compile").at(-1)!;
    assert.deepEqual(call, [
      "compile", "--fqbn", "arduino:avr:mega",
      "--build-property", "compiler.cpp.extra_flags=-DDEBUG=1",
      "--build-property", "compiler.c.extra_flags=-DDEBUG=1",
      path.join(sb.sketches, "proj"),
    ]);

    r = await mcp.call("compile_sketch", { name: "proj", fqbn: "arduino:avr:uno" });
    assert.match(r.text, /arduino:avr:uno/);

    await mcp.call("create_sketch", { name: "broken", template: "empty" });
    r = await mcp.call("compile_sketch", { name: "broken", fqbn: "arduino:avr:uno" });
    assert.match(r.text, /Compile failed/);
    assert.match(r.text, /broken\.ino:3:5 — 'foo' was not declared in this scope/);

    r = await mcp.call("compile_sketch", { name: "does_not_exist", fqbn: "arduino:avr:uno" });
    assert.equal(r.isError, true);
    assert.match(r.text, /not found/);

    r = await mcp.call("project_install_deps", { name: "proj" });
    assert.match(r.text, /✅ Servo: installed/);
  });

  test("wifi_upload uses the network protocol", { skip: !canRunFakeCli }, async () => {
    await mcp.call("create_sketch", { name: "ota", template: "wifi" });
    await mcp.call("wifi_upload", { name: "ota", ip: "192.168.1.50", fqbn: "esp32:esp32:esp32", password: "secret" });
    const call = cliCalls(sb).filter((c) => c[0] === "upload").at(-1)!;
    assert.deepEqual(call.slice(0, 7), ["upload", "--port", "192.168.1.50", "--protocol", "network", "--fqbn", "esp32:esp32:esp32"]);
    assert.ok(call.includes("password=secret"));

    const r = await mcp.call("wifi_upload", { name: "ota", ip: "--help", fqbn: "esp32:esp32:esp32" });
    assert.equal(r.isError, true);
  });

  test("arduino_cli_config reset needs confirmation", async () => {
    const r = await mcp.call("arduino_cli_config", { action: "reset" });
    assert.equal(r.isError, true);
    assert.match(r.text, /confirm=true/);
  });
});
