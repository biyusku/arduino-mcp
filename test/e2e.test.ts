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

  test("rename_sketch only renames real sketches", async () => {
    const libs = path.join(sb.sketches, "libraries");
    fs.mkdirSync(path.join(libs, "Servo"), { recursive: true });
    const r = await mcp.call("rename_sketch", { old_name: "libraries", new_name: "old_libs" });
    assert.equal(r.isError, true);
    assert.match(r.text, /not a sketch/);
    assert.ok(fs.existsSync(path.join(libs, "Servo")));
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

    r = await mcp.call("board_config", { action: "set", clear: ["psram"], upload_speed: "921600" });
    assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,UploadSpeed=921600\n/);

    // options given inside the FQBN behave like the dedicated parameters
    r = await mcp.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32s3:PSRAM=opi,DebugLevel=info" });
    assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,UploadSpeed=921600,DebugLevel=info\n/);
    r = await mcp.call("board_config", { action: "set", clear: ["psram"] });
    assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,UploadSpeed=921600,DebugLevel=info\n/);
    r = await mcp.call("board_config", { action: "show" });
    assert.match(r.text, /PSRAM:\s+board default/);

    r = await mcp.call("board_config", { action: "set", fqbn: "arduino:avr:uno", psram: "opi", upload_speed: "fast" });
    assert.match(r.text, /FQBN: arduino:avr:uno\n/);
    assert.match(r.text, /psram has no effect on avr boards and was not saved/);
    assert.match(r.text, /upload_speed has no effect on avr boards/);
    r = await mcp.call("board_config", { action: "show" }); // reloaded from disk
    assert.match(r.text, /FQBN:\s+arduino:avr:uno\n/);

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
    assert.equal(r.isError, false);
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

    // compiling never depends on the (here: unusual but valid) upload port
    r = await mcp.call("board_config", { action: "set", upload_port: "/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0" });
    assert.equal(r.isError, false, r.text);
    r = await mcp.call("compile_sketch", { name: "proj" });
    assert.match(r.text, /Compile succeeded/);

    await mcp.call("create_sketch", { name: "broken", template: "empty" });
    r = await mcp.call("compile_sketch", { name: "broken", fqbn: "arduino:avr:uno" });
    assert.equal(r.isError, true); // clients that branch on isError must see the failure
    assert.match(r.text, /Compile failed/);
    assert.match(r.text, /broken\.ino:3:5 — 'foo' was not declared in this scope/);

    r = await mcp.call("compile_sketch", { name: "does_not_exist", fqbn: "arduino:avr:uno" });
    assert.equal(r.isError, true);
    assert.match(r.text, /not found/);

    r = await mcp.call("compile_sketch", { name: "proj", verbose: true });
    assert.match(r.text, /--- arduino-cli output ---\nSketch uses 924 bytes/);

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

  test("detect_board keeps a board type the user chose, with its options", { skip: !canRunFakeCli }, async () => {
    fs.writeFileSync(path.join(sb.dir, "board-list.json"), JSON.stringify({
      detected_ports: [{
        port: { address: "/dev/ttyACM0", protocol: "serial", properties: { vid: "0x303a", pid: "0x1001", serialNumber: "S3SERIAL" } },
        matching_boards: [{ name: "ESP32S3 Dev Module", fqbn: "esp32:esp32:esp32s3" }, { name: "LOLIN S3", fqbn: "esp32:esp32:lolin_s3" }],
      }],
    }));
    let r = await mcp.call("detect_board");
    assert.match(r.text, /FQBN:\s+esp32:esp32:esp32s3\n/);
    assert.match(r.text, /Also matches: esp32:esp32:lolin_s3/);

    r = await mcp.call("board_config", { action: "set", fqbn: "esp32:esp32:lolin_s3", psram: "opi", flash_size: "16M" });
    assert.match(r.text, /FQBN: esp32:esp32:lolin_s3:FlashSize=16M,PSRAM=opi\n/);

    r = await mcp.call("detect_board"); // e.g. after re-plugging
    assert.match(r.text, /FQBN:\s+esp32:esp32:lolin_s3\n/);
    assert.match(r.text, /Keeping your board choice esp32:esp32:lolin_s3/);
    r = await mcp.call("board_config", { action: "show" });
    assert.match(r.text, /FQBN:\s+esp32:esp32:lolin_s3:FlashSize=16M,PSRAM=opi\n/);
  });

  test("project ports: v3 files are ignored, unpinned by default, stale pinned ports fall back", { skip: !canRunFakeCli }, async () => {
    await mcp.call("board_config", { action: "set", fqbn: "arduino:avr:uno", upload_port: "/dev/null" }); // /dev/null: present on every POSIX system
    await mcp.call("create_sketch", { name: "ports", template: "blink" });

    // v3 file with a stale port and another board: must not override the saved board
    fs.writeFileSync(path.join(sb.sketches, "ports", "arduino-mcp.yaml"),
      "# arduino-mcp project config\n# https://github.com/birusk/arduino-mcp\n\nname: ports\ndescription: Arduino project: ports\n" +
      "fqbn: esp32:esp32:esp32\nupload_port: /dev/ttyGONE0\nlibraries:\n  - Servo\n");
    let r = await mcp.call("compile_sketch", { name: "ports" });
    assert.match(r.text, /Compile succeeded \(arduino:avr:uno\)/);
    r = await mcp.call("project_info", { name: "ports" });
    assert.match(r.text, /written by arduino-mcp v3/);
    assert.match(r.text, /Libs:\s+Servo/);

    // project_init no longer copies the saved board into the file
    r = await mcp.call("project_init", { name: "ports", overwrite: true });
    assert.match(r.text, /FQBN:\s+saved board/);
    const yaml = fs.readFileSync(path.join(sb.sketches, "ports", "arduino-mcp.yaml"), "utf-8");
    assert.doesNotMatch(yaml, /fqbn|upload_port|monitor_port/);

    // a pinned port that is not connected falls back to the saved board's port
    await mcp.call("project_init", { name: "ports", overwrite: true, upload_port: "/dev/ttyGONE0" });
    r = await mcp.call("upload_sketch", { name: "ports", free_port: false });
    assert.match(r.text, /upload port \/dev\/ttyGONE0 is not connected; using the saved board's \/dev\/null/);

    // ...but never when the sketch is pinned to a different board: that would flash the wrong board
    await mcp.call("project_init", { name: "ports", overwrite: true, fqbn: "arduino:avr:nano", upload_port: "/dev/ttyGONE0" });
    const uploadsBefore = cliCalls(sb).filter((c) => c[0] === "upload").length;
    r = await mcp.call("upload_sketch", { name: "ports", free_port: false });
    assert.equal(r.isError, true);
    assert.match(r.text, /pins upload port \/dev\/ttyGONE0 for this sketch, but it is not connected/);
    assert.equal(cliCalls(sb).filter((c) => c[0] === "upload").length, uploadsBefore);
    r = await mcp.call("compile_sketch", { name: "ports" }); // compiling does not need the port
    assert.match(r.text, /Compile succeeded \(arduino:avr:nano\)/);
  });

  test("board_info runs esptool only for ESP boards, judged by the port itself", { skip: !canRunFakeCli }, async () => {
    fs.writeFileSync(path.join(sb.dir, "board-list.json"), JSON.stringify({
      detected_ports: [{
        port: { address: "/dev/ttyACM5", protocol: "serial", properties: { vid: "0x2341", pid: "0x0043", serialNumber: "UNO1" } },
        matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }],
      }],
    }));
    // saved board: an ESP32 on /dev/null (a device that exists everywhere)
    await mcp.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32", upload_port: "/dev/null", monitor_port: "/dev/null" });
    const esptoolCalls = () => cliCalls(sb).filter((c) => c.includes("flash_id"));

    let r = await mcp.call("board_info", { port: "/dev/ttyACM5" }); // the Uno
    assert.match(r.text, /Arduino Uno \(arduino:avr:uno\)/);
    assert.equal(esptoolCalls().length, 0);

    r = await mcp.call("board_info"); // the saved ESP32
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(esptoolCalls(), [["--port", "/dev/null", "flash_id"]]);
  });

  test("detect_board adopts a board configured by hand before the first detection", { skip: !canRunFakeCli }, async () => {
    const own = makeSandbox(); // fresh config: no board detected yet
    const fresh = await connect(own);
    try {
      let r = await fresh.call("board_config", { action: "set", fqbn: "esp32:esp32:lolin_s3", psram: "opi", flash_size: "16M" });
      assert.match(r.text, /FQBN: esp32:esp32:lolin_s3:FlashSize=16M,PSRAM=opi\n/);
      fs.writeFileSync(path.join(own.dir, "board-list.json"), JSON.stringify({
        detected_ports: [{
          port: { address: "/dev/ttyACM0", protocol: "serial", properties: { vid: "0x303a", pid: "0x1001", serialNumber: "S3NEW" } },
          matching_boards: [{ name: "ESP32S3 Dev Module", fqbn: "esp32:esp32:esp32s3" }, { name: "LOLIN S3", fqbn: "esp32:esp32:lolin_s3" }],
        }],
      }));
      r = await fresh.call("detect_board");
      assert.match(r.text, /FQBN:\s+esp32:esp32:lolin_s3\n/);
      assert.match(r.text, /Applied your manual setup \(esp32:esp32:lolin_s3:FlashSize=16M,PSRAM=opi\)/);
      r = await fresh.call("board_config", { action: "show" });
      assert.match(r.text, /ID:\s+S3NEW/);
      assert.match(r.text, /FQBN:\s+esp32:esp32:lolin_s3:FlashSize=16M,PSRAM=opi\n/);
      assert.match(r.text, /Upload port:\s+\/dev\/ttyACM0/);

      // a manual setup that does not fit the detected board stays saved, and can be selected again
      const own3 = makeSandbox();
      const fresh3 = await connect(own3);
      try {
        await fresh3.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32s3", psram: "opi", flash_size: "16M", upload_port: "/dev/ttyUSB9" });
        fs.writeFileSync(path.join(own3.dir, "board-list.json"), JSON.stringify({
          detected_ports: [{
            port: { address: "/dev/ttyACM3", protocol: "serial", properties: { vid: "0x2341", pid: "0x0043", serialNumber: "UNO1" } },
            matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }],
          }],
        }));
        r = await fresh3.call("detect_board");
        assert.match(r.text, /FQBN:\s+arduino:avr:uno\n/);
        assert.match(r.text, /switch back with: board_config action=use id=manual/);
        r = await fresh3.call("board_config", { action: "show" });
        assert.match(r.text, /ID:\s+UNO1/);
        assert.match(r.text, /Other saved:\s+manual\s+esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi\s+\/dev\/ttyUSB9/);

        r = await fresh3.call("board_config", { action: "use", id: "manual" });
        assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi\nUpload: \/dev\/ttyUSB9/);
        const saved = JSON.parse(fs.readFileSync(own3.env.ARDUINO_MCP_CONFIG, "utf-8"));
        assert.equal(saved.boards.UNO1.fqbn, "arduino:avr:uno"); // the Uno's entry is untouched
        assert.equal(saved.boards.UNO1.uploadPort, "/dev/ttyACM3");

        // detecting a board that already has its own entry while "manual" is the default: honest note
        r = await fresh3.call("detect_board");
        assert.match(r.text, /This board already has its own saved settings/);
        assert.doesNotMatch(r.text, /does not match/);

        // another board of the same type, while "manual" is not the default: only suggested, never applied silently
        fs.writeFileSync(path.join(own3.dir, "board-list.json"), JSON.stringify({
          detected_ports: [{
            port: { address: "/dev/ttyACM0", protocol: "serial", properties: { vid: "0x303a", pid: "0x1001", serialNumber: "S3LATE" } },
            matching_boards: [{ name: "ESP32S3 Dev Module", fqbn: "esp32:esp32:esp32s3" }],
          }],
        }));
        r = await fresh3.call("detect_board");
        assert.match(r.text, /FQBN:\s+esp32:esp32:esp32s3\n/);
        const apply = r.text.match(/apply it with: board_config action=set fqbn=(\S+)/)?.[1];
        assert.equal(apply, "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi");
        r = await fresh3.call("board_config", { action: "show" });
        assert.match(r.text, /ID:\s+S3LATE/);
        assert.match(r.text, /FQBN:\s+esp32:esp32:esp32s3\n/);
        assert.match(r.text, /Other saved:.*\bmanual\b|\n\s+manual\s/);

        r = await fresh3.call("board_config", { action: "set", fqbn: apply });
        assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi\nUpload: \/dev\/ttyACM0/);

        r = await fresh3.call("board_config", { action: "use", id: "nope" });
        assert.equal(r.isError, true);
        assert.match(r.text, /Saved: .*S3LATE/);
      } finally {
        await fresh3.close();
      }

      // an unidentified board while "manual" is not the default: an honest, conditional hint
      const own4 = makeSandbox();
      const fresh4 = await connect(own4);
      try {
        await fresh4.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32s3", psram: "opi" });
        const list = (ports: object[]) => fs.writeFileSync(path.join(own4.dir, "board-list.json"), JSON.stringify({ detected_ports: ports }));
        list([{ port: { address: "/dev/ttyACM3", protocol: "serial", properties: { vid: "0x2341", pid: "0x0043", serialNumber: "UNO1" } },
          matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }] }]);
        await fresh4.call("detect_board"); // the Uno becomes the default, "manual" is kept
        list([{ port: { address: "/dev/ttyUSB0", protocol: "serial", properties: { vid: "0x1a86", pid: "0x7523" } } }]);
        r = await fresh4.call("detect_board");
        assert.doesNotMatch(r.text, /is for this board type/);
        assert.match(r.text, /could not be identified\. If this is the board of your manual setup \(esp32:esp32:esp32s3:PSRAM=opi\)/);
      } finally {
        await fresh4.close();
      }

      // an unidentifiable clone takes over a manual Nano setup as well
      const own2 = makeSandbox();
      const fresh2 = await connect(own2);
      try {
        await fresh2.call("board_config", { action: "set", fqbn: "arduino:avr:nano:cpu=atmega328old" });
        fs.writeFileSync(path.join(own2.dir, "board-list.json"), JSON.stringify({
          detected_ports: [{ port: { address: "/dev/ttyUSB0", protocol: "serial", properties: { vid: "0x1a86", pid: "0x7523" } } }],
        }));
        await fresh2.call("detect_board");
        r = await fresh2.call("board_config", { action: "show" });
        assert.match(r.text, /FQBN:\s+arduino:avr:nano:cpu=atmega328old\n/);
      } finally {
        await fresh2.close();
      }
    } finally {
      await fresh.close();
    }
  });

  test("board_config rejects arguments that the action would ignore", async () => {
    let r = await mcp.call("board_config", { action: "set", id: "manual", upload_port: "/dev/ttyACM0" });
    assert.equal(r.isError, true);
    assert.match(r.text, /id is only used with action=use/);
    r = await mcp.call("board_config", { action: "use", id: "manual", upload_port: "/dev/ttyACM0" });
    assert.equal(r.isError, true);
    assert.match(r.text, /does not change settings \(upload_port\)/);
    r = await mcp.call("board_config", { fqbn: "arduino:avr:uno" }); // action defaults to show
    assert.equal(r.isError, true);
    assert.match(r.text, /action=show does not change settings \(fqbn\); use action=set/);

    // clients that send every field, empty when unused, still work
    const empty = { id: "", fqbn: "", upload_port: "", monitor_port: "", flash_size: "", psram: "", cdc_on_boot: "",
      partition_scheme: "", upload_speed: "", extra_options: "" };
    r = await mcp.call("board_config", { ...empty, action: "show" });
    assert.equal(r.isError, false, r.text);
    r = await mcp.call("board_config", { ...empty, action: "set", fqbn: "arduino:avr:nano:cpu=atmega328old", upload_port: "/dev/ttyUSB0", monitor_port: "/dev/ttyUSB0" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /FQBN: arduino:avr:nano:cpu=atmega328old\nUpload: \/dev\/ttyUSB0 \| Monitor: \/dev\/ttyUSB0/);
    // changing just the port keeps everything else ("" = not given)
    r = await mcp.call("board_config", { ...empty, action: "set", upload_port: "/dev/ttyUSB1" });
    assert.match(r.text, /FQBN: arduino:avr:nano:cpu=atmega328old\nUpload: \/dev\/ttyUSB1 \| Monitor: \/dev\/ttyUSB0/);
    // options inside the fqbn are kept too
    r = await mcp.call("board_config", { ...empty, action: "set", fqbn: "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi" });
    assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi\n/);

    // removing settings is explicit
    r = await mcp.call("board_config", { action: "set", clear: ["psram", "monitor_port"] });
    assert.match(r.text, /FQBN: esp32:esp32:esp32s3:FlashSize=16M\nUpload: \/dev\/ttyUSB1 \| Monitor: not set/);
    r = await mcp.call("board_config", { action: "set", fqbn: "esp8266:esp8266:nodemcuv2", extra_options: "eesz=4M2M" });
    r = await mcp.call("board_config", { action: "set", clear: ["flash_size"] });
    assert.match(r.text, /flash_size does not apply to esp8266 boards, so nothing was cleared/);
    assert.match(r.text, /FQBN: esp8266:esp8266:nodemcuv2:eesz=4M2M\n/);
    r = await mcp.call("board_config", { action: "set", psram: "opi", clear: ["psram"] });
    assert.equal(r.isError, true);
    assert.match(r.text, /psram given and cleared in the same call/);
    r = await mcp.call("board_config", { action: "show", clear: ["psram"] });
    assert.equal(r.isError, true);
  });

  test("board ids that are Object.prototype names are just unknown ids", async () => {
    for (const id of ["__proto__", "hasOwnProperty", "constructor", "toString"]) {
      const r = await mcp.call("board_config", { action: "use", id });
      assert.equal(r.isError, true, id);
      assert.match(r.text, /No saved board/);
    }
    const r = await mcp.call("list_sketches"); // the server still answers
    assert.equal(r.isError, false);
  });

  test("erase_flash judges the board on the given port, not the saved board", { skip: !canRunFakeCli }, async () => {
    const list = (fqbn: string) => fs.writeFileSync(path.join(sb.dir, "board-list.json"), JSON.stringify({
      detected_ports: [{ port: { address: "/dev/zero", protocol: "serial", properties: { vid: "0x10c4", pid: "0xea60" } }, matching_boards: [{ name: "x", fqbn }] }],
    }));
    // saved board: an Uno elsewhere; on /dev/zero arduino-cli sees an ESP32
    await mcp.call("board_config", { action: "set", fqbn: "arduino:avr:uno", upload_port: "/dev/null", monitor_port: "/dev/null" });
    list("esp32:esp32:esp32");
    let r = await mcp.call("erase_flash", { port: "/dev/zero", free_port: false });
    assert.equal(r.isError, false, r.text);
    assert.ok(cliCalls(sb).some((c) => c.join(" ") === "--port /dev/zero erase_flash"));

    // and the reverse: saved board is an ESP32, the given port is an Uno
    await mcp.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32" });
    list("arduino:avr:uno");
    r = await mcp.call("erase_flash", { port: "/dev/zero", free_port: false });
    assert.equal(r.isError, true);
    assert.match(r.text, /the board on \/dev\/zero is "avr"/);
  });

  test("with several boards, detect_board port=... saves that board under its own id", { skip: !canRunFakeCli }, async () => {
    const own = makeSandbox();
    const fresh = await connect(own);
    try {
      fs.writeFileSync(path.join(own.dir, "board-list.json"), JSON.stringify({
        detected_ports: [
          { port: { address: "/dev/ttyACM0", protocol: "serial", properties: { vid: "0x2341", pid: "0x0043", serialNumber: "UNO_A" } },
            matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }] },
          { port: { address: "/dev/ttyUSB0", protocol: "serial", properties: { vid: "0x10c4", pid: "0xea60", serialNumber: "ESP_B" } },
            matching_boards: [{ name: "ESP32 Dev Module", fqbn: "esp32:esp32:esp32" }] },
        ],
      }));
      let r = await fresh.call("detect_board");
      assert.match(r.text, /run detect_board with its port/);
      const first = r.text.match(/Serial no:\s+(\S+)/)?.[1];
      const other = first === "UNO_A" ? "/dev/ttyUSB0" : "/dev/ttyACM0";

      r = await fresh.call("detect_board", { port: other });
      assert.match(r.text, new RegExp(`Port:\\s+${other.replace(/\//g, "\\/")} \\(upload \\+ monitor\\)`));
      const saved = JSON.parse(fs.readFileSync(own.env.ARDUINO_MCP_CONFIG, "utf-8"));
      assert.equal(saved.boards.UNO_A.uploadPort, "/dev/ttyACM0");
      assert.equal(saved.boards.ESP_B.uploadPort, "/dev/ttyUSB0");
      assert.equal(saved.boards.ESP_B.fqbn, "esp32:esp32:esp32");
      assert.equal(saved.defaultBoard, first === "UNO_A" ? "ESP_B" : "UNO_A");

      r = await fresh.call("detect_board", { port: "/dev/ttyUSB7" });
      assert.equal(r.isError, true);
      assert.match(r.text, /No connected board on \/dev\/ttyUSB7/);
    } finally {
      await fresh.close();
    }
  });

  test("arduino_cli_config reset needs confirmation", async () => {
    const r = await mcp.call("arduino_cli_config", { action: "reset" });
    assert.equal(r.isError, true);
    assert.match(r.text, /confirm=true/);
  });
});
