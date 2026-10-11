/**
 * End-to-end serial tests against a fake board on a pseudo-terminal.
 * Linux only (needs python3; CI and most dev machines have it).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { commandExists } from "../src/lib/exec.js";
import { cliCalls, connect, makeSandbox, ROOT, SERVER_ARGS, startFakeBoard, type Sandbox } from "./helpers.js";

const supported = process.platform === "linux" && commandExists("python3");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("serial tools with a fake board", { skip: !supported }, () => {
  let sb: Sandbox;
  let board: { port: string; proc: ChildProcessWithoutNullStreams };
  let mcp: Awaited<ReturnType<typeof connect>>;

  before(async () => {
    sb = makeSandbox();
    board = await startFakeBoard();
    mcp = await connect(sb);
  });
  after(async () => {
    await mcp.close();
    board.proc.kill();
  });

  test("one-shot read and send (no background session)", async () => {
    let r = await mcp.call("serial_monitor", { port: board.port, seconds: 1 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /tick \d+/);

    r = await mcp.call("send_serial", { port: board.port, message: "hello", response_seconds: 0.5 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /ECHO:hello/);
  });

  test("background session: read, send through it, monitor through it", async () => {
    let r = await mcp.call("serial_start", { port: board.port });
    assert.match(r.text, /Started on/);
    await sleep(700);

    r = await mcp.call("serial_read", { port: board.port, lines: 5 });
    assert.match(r.text, /tick \d+/);

    r = await mcp.call("send_serial", { port: board.port, message: "LED_ON", response_seconds: 0.5 });
    assert.match(r.text, /ECHO:LED_ON/);

    r = await mcp.call("serial_monitor", { port: board.port, seconds: 1 });
    assert.match(r.text, /tick \d+/);

    r = await mcp.call("serial_status");
    assert.match(r.text, new RegExp(`${board.port}\\s+@ 115200 baud`));

    // a different baud than the running session's is an error, not silently ignored
    r = await mcp.call("serial_monitor", { port: board.port, baud: 9600, seconds: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /running on .* at 115200 baud/);
    r = await mcp.call("send_serial", { port: board.port, baud: 9600, message: "x" });
    assert.equal(r.isError, true);

    // serial_read without a port finds the only running session
    r = await mcp.call("serial_read", { lines: 3 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, new RegExp(`${board.port} — last`));
  });

  test("upload pauses and resumes the session and shows the real upload error", async () => {
    await mcp.call("create_sketch", { name: "up", template: "blink" });
    const r = await mcp.call("upload_sketch", { name: "up", fqbn: "arduino:avr:uno", port: board.port, free_port: false });
    assert.equal(r.isError, true);
    assert.match(r.text, /Upload failed/);
    assert.match(r.text, /avrdude: ser_open\(\): can't open device/); // was hidden before
    assert.match(r.text, /Serial session on .* resumed/);
    const status = await mcp.call("serial_status");
    assert.match(status.text, new RegExp(board.port));
  });

  test("erase_flash pauses and resumes the session like upload does", async () => {
    await mcp.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32", upload_port: board.port, monitor_port: board.port });
    const r = await mcp.call("erase_flash", { free_port: false });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Flash erase completed/);
    assert.match(r.text, /Serial session on .* resumed/);
    assert.ok(cliCalls(sb).some((c) => c.join(" ") === `--port ${board.port} erase_flash`));
  });

  test("send_serial waits for boards that reset on open, judged by the port's own board", async () => {
    await mcp.call("serial_stop");
    // saved board: an ESP32 elsewhere (no reset delay); on the fake board's port arduino-cli sees an Uno
    await mcp.call("board_config", { action: "set", fqbn: "esp32:esp32:esp32", upload_port: "/dev/null", monitor_port: "/dev/null" });
    fs.writeFileSync(path.join(sb.dir, "board-list.json"), JSON.stringify({
      detected_ports: [{ port: { address: board.port, protocol: "serial", properties: { vid: "0x2341", pid: "0x0043" } },
        matching_boards: [{ name: "Arduino Uno", fqbn: "arduino:avr:uno" }] }],
    }));
    const started = Date.now();
    const r = await mcp.call("send_serial", { port: board.port, message: "hi", response_seconds: 0.3 });
    assert.match(r.text, /ECHO:hi/);
    assert.ok(Date.now() - started >= 2000, "no reset delay for the Uno on the given port");
    await mcp.call("serial_start", { port: board.port }); // the next test expects a running session
  });

  test("serial_stop", async () => {
    let r = await mcp.call("serial_stop", { port: board.port });
    assert.match(r.text, /Stopped/);
    r = await mcp.call("serial_read", { port: board.port });
    assert.match(r.text, /No background session/);
  });

  test("serial tools take monitor port and baud from a sketch's arduino-mcp.yaml", async () => {
    await mcp.call("create_sketch", { name: "pinned", template: "blink" });
    await mcp.call("project_init", { name: "pinned", monitor_port: board.port, baud: 9600 });
    let r = await mcp.call("serial_start", { sketch: "pinned" });
    assert.match(r.text, new RegExp(`Started on ${board.port} @ 9600 baud`));
    r = await mcp.call("serial_monitor", { sketch: "pinned", seconds: 1 });
    assert.match(r.text, /@ 9600 \(1s\)/);
    await mcp.call("serial_stop", { port: board.port });

    await mcp.call("project_init", { name: "pinned", overwrite: true, monitor_port: "/dev/ttyGONE7" });
    r = await mcp.call("serial_monitor", { sketch: "pinned", seconds: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /pins monitor port \/dev\/ttyGONE7 for this sketch, but it is not connected/);
  });

  test("invalid and missing ports are reported", async () => {
    let r = await mcp.call("serial_monitor", { port: "/dev/ttyDOESNOTEXIST9", seconds: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /not found/);
    r = await mcp.call("serial_start", { port: "/home/x; id" });
    assert.equal(r.isError, true);
  });
});

describe("process lifecycle", { skip: !supported }, () => {
  test("server exits when the client closes stdin, even with an open serial session", async () => {
    const board = await startFakeBoard();
    const sb = makeSandbox();
    const child = spawn(process.execPath, SERVER_ARGS, { cwd: ROOT, env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map<number, unknown>();
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
    });
    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
    const waitFor = async (id: number) => {
      for (let i = 0; i < 100 && !responses.has(id); i++) await sleep(100);
      return responses.get(id) as { result?: { content: Array<{ text: string }> } };
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "serial_start", arguments: { port: board.port } } });
    const started = await waitFor(2);
    assert.match(started.result!.content[0].text, /Started on/);

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.stdin.end();
    const code = await Promise.race([exited, sleep(5000).then(() => "timeout" as const)]);
    board.proc.kill();
    if (code === "timeout") child.kill("SIGKILL");
    assert.equal(code, 0);
  });
});

describe("shutdown", { skip: process.platform === "win32" }, () => {
  test("closing stdin also stops a running arduino-cli process", { timeout: 30_000 }, async () => {
    const sb = makeSandbox();
    fs.mkdirSync(path.join(sb.sketches, "slow"));
    fs.writeFileSync(path.join(sb.sketches, "slow", "slow.ino"), "void setup(){}\nvoid loop(){}\n");
    const child = spawn(process.execPath, SERVER_ARGS, { cwd: ROOT, env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "compile_sketch", arguments: { name: "slow", fqbn: "arduino:avr:uno" } } });

    const pidFile = sb.cliLog + ".slowpid";
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(100);
    const cliPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
    try {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      await Promise.race([exited, sleep(10_000)]);
      assert.notEqual(child.exitCode, null, "server did not exit");
      let alive = true;
      try {
        process.kill(cliPid, 0);
      } catch {
        alive = false;
      }
      const ps = alive ? spawnSync("ps", ["-o", "stat=", "-p", String(cliPid)], { encoding: "utf8" }).stdout.trim() : "";
      assert.ok(!alive || ps.startsWith("Z") || ps === "", `arduino-cli (pid ${cliPid}) still running: ${ps}`);
    } finally {
      try { process.kill(cliPid, "SIGKILL"); } catch { /* gone */ }
      child.kill("SIGKILL");
    }
  });
});

describe("releasePort", { skip: !supported || !commandExists("lsof") }, () => {
  test("stops another process that holds the port, never ourselves", async () => {
    const { releasePort } = await import("../src/lib/ports.js");
    const holder = await startFakeBoard(); // this python process keeps its pty open
    const exited = new Promise((resolve) => holder.proc.once("exit", resolve));
    // a pty is not a serial device, so treat it as one for this test only
    const stopped = await releasePort(holder.port, async () => true);
    assert.equal(stopped.length, 1, JSON.stringify(stopped));
    assert.match(stopped[0], new RegExp(`pid ${holder.proc.pid}`));
    await exited;
    await assert.rejects(releasePort("/home/me/.bashrc"), /Invalid serial port/);
  });

  test("never touches holders of terminals or other devices", async (t) => {
    const { releasePort, isReleasableSerialPort } = await import("../src/lib/ports.js");
    // If the guard ever regresses, this test must fail, not SIGTERM the developer's processes.
    const kills: unknown[] = [];
    t.mock.method(process, "kill", (...args: unknown[]) => {
      kills.push(args);
      return true;
    });
    const holder = await startFakeBoard();
    try {
      for (const dev of ["/dev/null", "/dev/tty", "/dev/zero", holder.port]) {
        assert.equal(await isReleasableSerialPort(dev), false, dev);
        assert.deepEqual(await releasePort(dev), [], dev);
      }
      assert.deepEqual(kills, []);
    } finally {
      t.mock.restoreAll();
      holder.proc.kill();
    }
  });
});
