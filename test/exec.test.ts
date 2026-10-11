import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { commandExists, run } from "../src/lib/exec.js";

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
