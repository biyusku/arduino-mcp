import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { commandExists, naturalCompare, run } from "../src/lib/exec.js";

test("arguments are passed literally, never through a shell", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-exec-"));
  const marker = path.join(dir, "PWNED");
  const payload = `x"; touch ${marker}; echo "$(id) \`id\` | & ; >`;
  const r = await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", payload]);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, payload);
  assert.equal(fs.existsSync(marker), false);
});

test("stdout and stderr are both captured, exit codes reported", async () => {
  const r = await run(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(3)"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "out");
  assert.equal(r.stderr, "err");
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
});

test("missing command is reported, not thrown", async () => {
  const r = await run("definitely-not-a-real-command-xyz", ["--version"]);
  assert.equal(r.ok, false);
  assert.match(r.output, /Command not found: definitely-not-a-real-command-xyz/);
});

test("timeouts kill the child", async () => {
  const r = await run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.output, /Timed out/);
});

test("commandExists", () => {
  assert.equal(commandExists("definitely-not-a-real-command-xyz"), false);
  assert.equal(commandExists(process.platform === "win32" ? "cmd" : "sh"), true);
});

test("UTF-8 characters split across output chunks are decoded correctly", async () => {
  const script = "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa7, 0x0a])), 50)";
  const r = await run(process.execPath, ["-e", script]);
  assert.equal(r.stdout, "ç");
});

test("timeout kills grandchildren that ignore SIGTERM and hold the pipes", { skip: process.platform === "win32" }, async () => {
  // child starts a grandchild that ignores SIGTERM, inherits stdout and prints its pid
  const grandchild = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`;
  const started = Date.now();
  const r = await run(process.execPath, ["-e", child], { timeoutMs: 500, killGraceMs: 300 });
  assert.ok(Date.now() - started < 5000, "run() must return even though the pipes were held open");
  assert.equal(r.ok, false);
  assert.match(r.output, /Timed out/);
  const pid = parseInt(r.stdout, 10);
  assert.ok(pid > 0, r.stdout);
  await new Promise((res) => setTimeout(res, 100));
  // gone, or a zombie waiting to be reaped by init (state "Z")
  const ps = await run("ps", ["-o", "stat=", "-p", String(pid)]);
  assert.ok(!ps.stdout || ps.stdout.startsWith("Z"), `grandchild still running: ${ps.stdout}`);
});

test("naturalCompare orders version numbers numerically", () => {
  assert.deepEqual(
    ["arduino-ide_2.3.10_Linux_64bit.AppImage", "arduino-ide_2.3.9_Linux_64bit.AppImage", "arduino-ide_2.10.0_Linux_64bit.AppImage"].sort(naturalCompare),
    ["arduino-ide_2.3.9_Linux_64bit.AppImage", "arduino-ide_2.3.10_Linux_64bit.AppImage", "arduino-ide_2.10.0_Linux_64bit.AppImage"]
  );
  assert.deepEqual(["4.9.1", "4.10.0", "5.0.2"].sort(naturalCompare).reverse(), ["5.0.2", "4.10.0", "4.9.1"]);
});

