import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { commandExists, naturalCompare, processTree, run, TreeKiller, type ProcInfo } from "../src/lib/exec.js";

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

// Helpers for the process-tree tests: grandchildren write their pid to a file,
// and every test kills them in the end, even if the code under test fails.
const leftovers: number[] = [];
after(() => leftovers.forEach((pid) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }));

async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = await run("ps", ["-o", "stat=", "-p", String(pid)]);
  return !!ps.stdout && !ps.stdout.startsWith("Z"); // zombies wait for init to reap them
}

async function waitUntilDead(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    if (!(await isRunning(pid))) return true;
  }
  return !(await isRunning(pid));
}

/** A child that starts a SIGTERM-ignoring grandchild (optionally in its own process group). */
function treeScript(pidFile: string, grandchildOpts: string): string {
  const grandchild = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  return `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], ${grandchildOpts}); setInterval(() => {}, 1000)`;
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = parseInt(fs.readFileSync(file, "utf-8"), 10);
  leftovers.push(pid);
  return pid;
}

const posixOnly = { skip: process.platform === "win32", timeout: 20_000 };

test("timeout: a same-group grandchild that ignores SIGTERM and holds the pipes is killed", posixOnly, async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amcp-tree-")), "pid");
  const started = Date.now();
  // grace (3 s) longer than the 2 s "exit" fallback: SIGKILL must still follow after run() returned
  const r = await run(process.execPath, ["-e", treeScript(pidFile, "{ stdio: 'inherit' }")], { timeoutMs: 500, killGraceMs: 3000 });
  assert.ok(Date.now() - started < 4000, "run() must return although the pipes are held open");
  assert.match(r.output, /Timed out/);
  assert.ok(await waitUntilDead(await readPid(pidFile), 5000), "grandchild survived");
});

test("timeout: a grandchild in its own process group (like avrdude under arduino-cli) is killed", posixOnly, async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amcp-tree-")), "pid");
  const r = await run(process.execPath, ["-e", treeScript(pidFile, "{ stdio: 'ignore', detached: true }")], { timeoutMs: 800, killGraceMs: 500 });
  assert.match(r.output, /Timed out/);
  assert.ok(await waitUntilDead(await readPid(pidFile), 5000), "grandchild in its own group survived");
});

test("processTree finds descendants across process groups, never our own group", () => {
  const ownGroup = 4242;
  const table = [
    { pid: process.pid, ppid: 1, pgid: ownGroup },
    { pid: 100, ppid: process.pid, pgid: 100 },   // the detached child
    { pid: 101, ppid: 100, pgid: 101 },           // tool in its own group
    { pid: 102, ppid: 101, pgid: 101 },
    { pid: 103, ppid: 100, pgid: ownGroup },      // (impossible in practice) must not be group-killed
    { pid: 200, ppid: 1, pgid: 200 },             // unrelated
  ];
  const tree = processTree(100, table);
  assert.deepEqual(tree.pids.sort(), [101, 102, 103]);
  assert.deepEqual(tree.groups.sort(), [101]);
});

test("naturalCompare orders version numbers numerically", () => {
  assert.deepEqual(
    ["arduino-ide_2.3.10_Linux_64bit.AppImage", "arduino-ide_2.3.9_Linux_64bit.AppImage", "arduino-ide_2.10.0_Linux_64bit.AppImage"].sort(naturalCompare),
    ["arduino-ide_2.3.9_Linux_64bit.AppImage", "arduino-ide_2.3.10_Linux_64bit.AppImage", "arduino-ide_2.10.0_Linux_64bit.AppImage"]
  );
  assert.deepEqual(["4.9.1", "4.10.0", "5.0.2"].sort(naturalCompare).reverse(), ["5.0.2", "4.10.0", "4.9.1"]);
});

function fakeKiller(initial: ProcInfo[], runningChildren: number[] = []) {
  const state = { table: initial, kills: [] as string[] };
  const killer = new TreeKiller(100, {
    platform: "linux",
    readTable: () => state.table,
    kill: (pid, sig) => void state.kills.push(`${sig} ${pid}`),
    isRunningChild: (pid) => runningChildren.includes(pid),
  });
  return { killer, state, kills: () => state.kills.splice(0).sort() };
}

test("TreeKiller: records the tree while the child lives, never signals a reused pid after it exited", () => {
  const { killer, state, kills } = fakeKiller([
    { pid: 100, ppid: process.pid, pgid: 100 }, // the child
    { pid: 101, ppid: 100, pgid: 101 },         // tool in its own group, ignores SIGTERM
    { pid: 102, ppid: 100, pgid: 100 },         // same-group helper
  ]);
  killer.signal("SIGTERM");
  assert.deepEqual(kills(), ["SIGTERM -100", "SIGTERM -101", "SIGTERM 100", "SIGTERM 101", "SIGTERM 102"].sort());

  // child and helper are gone; pid 100 now belongs to an unrelated group leader
  killer.markExited();
  state.table = [{ pid: 100, ppid: 1, pgid: 100 }, { pid: 101, ppid: 1, pgid: 101 }];
  killer.signal("SIGKILL");
  assert.deepEqual(kills(), ["SIGKILL -101", "SIGKILL 101"]);
});

test("TreeKiller: after the child exited, its group is still killed while leftovers remain", () => {
  // first signal only after exit (timeout in the exit→close window, or shutdown): nothing recorded yet
  const { killer, state, kills } = fakeKiller([{ pid: 102, ppid: 1, pgid: 100 }]);
  killer.markExited();
  killer.signal("SIGTERM");
  assert.deepEqual(kills(), ["SIGTERM -100"]); // pid 100 is free while group 100 has members: still ours

  // a recorded tool group whose remaining member was never recorded
  state.table = [{ pid: 100, ppid: process.pid, pgid: 100 }, { pid: 101, ppid: 100, pgid: 101 }];
  const second = fakeKiller(state.table);
  second.killer.signal("SIGTERM");
  second.kills();
  second.killer.markExited();
  second.state.table = [{ pid: 103, ppid: 1, pgid: 101 }];
  second.killer.signal("SIGKILL");
  assert.deepEqual(second.kills(), ["SIGKILL -101"]);
});

test("TreeKiller: a recorded pid reused by another running run() child is left alone", () => {
  const { killer, state, kills } = fakeKiller([{ pid: 100, ppid: process.pid, pgid: 100 }, { pid: 101, ppid: 100, pgid: 101 }], [101]);
  killer.signal("SIGTERM");
  kills();
  killer.markExited();
  state.table = [{ pid: 101, ppid: process.pid, pgid: 101 }]; // e.g. the next run()'s arduino-cli
  killer.signal("SIGKILL");
  assert.deepEqual(kills(), []);
});

test("TreeKiller: a leftover re-parented to this server (server is PID 1 in a container) is still killed", () => {
  const { killer, state, kills } = fakeKiller([{ pid: 100, ppid: process.pid, pgid: 100 }, { pid: 101, ppid: 100, pgid: 101 }]);
  killer.signal("SIGTERM");
  kills();
  killer.markExited();
  state.table = [{ pid: 101, ppid: process.pid, pgid: 101 }]; // the orphaned tool, now our child
  killer.signal("SIGKILL");
  assert.deepEqual(kills(), ["SIGKILL -101", "SIGKILL 101"]);
});

test("TreeKiller: without ps, falls back to the recorded groups", () => {
  const { killer, state, kills } = fakeKiller([]);
  killer.signal("SIGTERM");
  assert.deepEqual(kills(), ["SIGTERM -100", "SIGTERM 100"]);
  killer.markExited();
  state.table = [];
  killer.signal("SIGKILL");
  assert.deepEqual(kills(), ["SIGKILL -100"]);
});

test("timeout in the window between the child's exit and its pipes closing still kills the leftovers", posixOnly, async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amcp-tree-")), "pid");
  const grandchild = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  // the child exits after 300 ms; the grandchild keeps the pipes open, so the timeout (1 s) fires after the exit
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setTimeout(() => process.exit(0), 300)`;
  const r = await run(process.execPath, ["-e", child], { timeoutMs: 1000, killGraceMs: 500 });
  assert.match(r.output, /Timed out/);
  assert.ok(await waitUntilDead(await readPid(pidFile), 5000), "grandchild survived");
});

test("TreeKiller on Windows: one taskkill /T /F while the child lives, none after it exited", () => {
  const calls: number[] = [];
  const killer = new TreeKiller(4242, { platform: "win32", taskkill: (pid) => void calls.push(pid) });
  killer.signal("SIGTERM");
  killer.signal("SIGKILL");
  assert.deepEqual(calls, [4242]);

  const exited = new TreeKiller(4243, { platform: "win32", taskkill: (pid) => void calls.push(pid) });
  exited.markExited();
  exited.signal("SIGTERM");
  assert.deepEqual(calls, [4242]);
});

