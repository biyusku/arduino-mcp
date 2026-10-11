/**
 * Process helpers. Commands are always started without a shell and with an
 * argument array, so user/LLM supplied values can never be interpreted as
 * shell syntax.
 */
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in the order they arrived */
  output: string;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** After a timeout, how long to wait before SIGKILL (default 5 s) */
  killGraceMs?: number;
}

interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
}

function readProcessTable(): ProcInfo[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5_000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((f) => f.length === 3 && f.every(Number.isInteger))
    .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}

/**
 * All descendants of `root` and their process groups (POSIX). This server's
 * own process group is never included.
 */
export function processTree(root: number, table: ProcInfo[] = readProcessTable()): { pids: number[]; groups: number[] } {
  const children = new Map<number, ProcInfo[]>();
  for (const p of table) {
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const ownGroup = table.find((p) => p.pid === process.pid)?.pgid;
  const pids: number[] = [];
  const groups = new Set<number>();
  const queue = [root];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (pids.includes(c.pid)) continue;
      pids.push(c.pid);
      if (c.pgid > 1 && c.pgid !== ownGroup) groups.add(c.pgid);
      queue.push(c.pid);
    }
  }
  return { pids, groups: [...groups] };
}

/**
 * Kills a child and everything it started. arduino-cli runs avrdude/esptool
 * in process groups of their own, so signalling the child's group is not
 * enough: the process tree is read first (orphans are re-parented once the
 * child dies) and every group and process in it gets the signal.
 */
class TreeKiller {
  private pids = new Set<number>();
  private groups = new Set<number>();

  constructor(private readonly root: number | undefined) {
    if (root) this.groups.add(root); // the child leads its own group (detached)
  }

  signal(sig: NodeJS.Signals): void {
    const root = this.root;
    if (!root) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(root), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
      return;
    }
    const tree = processTree(root);
    tree.pids.forEach((p) => this.pids.add(p));
    tree.groups.forEach((g) => this.groups.add(g));
    for (const g of this.groups) {
      try {
        process.kill(-g, sig);
      } catch {
        // group already gone
      }
    }
    for (const p of [root, ...this.pids]) {
      try {
        process.kill(p, sig);
      } catch {
        // already gone
      }
    }
  }
}

export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const child = spawn(file, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // own process group on POSIX, so a timeout can kill grandchildren too
      detached: process.platform !== "win32",
    });
    // decode as a stream: multi-byte UTF-8 characters may be split across chunks
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const timeoutNote = () => `Timed out after ${Math.round(timeoutMs / 1000)}s`;
    const killer = new TreeKiller(child.pid);

    timers.push(setTimeout(() => {
      timedOut = true;
      killer.signal("SIGTERM");
      // Not in `timers`: SIGKILL must still follow even if run() already
      // returned because the child itself exited (leftovers may ignore SIGTERM).
      setTimeout(() => {
        killer.signal("SIGKILL");
        finish(null, timeoutNote());
      }, killGraceMs).unref();
    }, timeoutMs));

    child.stdout.on("data", (s: string) => {
      stdout += s;
      output += s;
    });
    child.stderr.on("data", (s: string) => {
      stderr += s;
      output += s;
    });

    function finish(code: number | null, note?: string) {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      if (note) {
        stderr += (stderr ? "\n" : "") + note;
        output += (output ? "\n" : "") + note;
      }
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output: output.trim(),
      });
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(null, err.code === "ENOENT" ? `Command not found: ${file}` : err.message);
    });
    child.on("exit", (code) => {
      // Normally "close" follows once the pipes are drained. If a leftover
      // grandchild keeps them open, do not wait for it forever.
      timers.push(setTimeout(() => finish(code, timedOut ? timeoutNote() : undefined), 2_000));
    });
    child.on("close", (code) => {
      finish(code, timedOut ? timeoutNote() : undefined);
    });
  });
}

/** Returns true if an executable with this name is found on PATH. */
export function commandExists(name: string): boolean {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Compares strings with embedded version numbers numerically ("2.3.9" < "2.3.10"). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
