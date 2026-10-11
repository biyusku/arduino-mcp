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

export interface ProcInfo {
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

export interface KillDeps {
  platform: string;
  readTable: () => ProcInfo[];
  kill: (pid: number, sig: NodeJS.Signals) => void;
  taskkill: (pid: number) => void;
}

const defaultKillDeps: KillDeps = {
  platform: process.platform,
  readTable: readProcessTable,
  kill: (pid, sig) => process.kill(pid, sig),
  taskkill: (pid) => {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
  },
};

/**
 * Kills a child and everything it started. arduino-cli runs avrdude/esptool
 * in process groups of their own, so signalling the child's group is not
 * enough: the process tree is read while the child is alive and every group
 * and process in it gets the signal.
 *
 * Once the child has exited its pid may be reused, so from then on only the
 * recorded processes that still exist (same pid and same group) are
 * signalled. On Windows, taskkill /T /F is forceful and walks the tree from
 * the live child, so it runs once and never after the child exited.
 */
export class TreeKiller {
  private pids = new Set<number>();
  private groups = new Set<number>();
  private exited = false;
  private taskkilled = false;
  private readonly deps: KillDeps;

  constructor(private readonly root: number | undefined, deps: Partial<KillDeps> = {}) {
    this.deps = { ...defaultKillDeps, ...deps };
    if (root) this.groups.add(root); // the child leads its own group (detached)
  }

  /** The child itself has exited (and was reaped): its pid may be reused from now on. */
  markExited(): void {
    this.exited = true;
  }

  signal(sig: NodeJS.Signals): void {
    const root = this.root;
    if (!root) return;
    if (this.deps.platform === "win32") {
      if (this.exited || this.taskkilled) return;
      this.taskkilled = true;
      this.deps.taskkill(root);
      return;
    }
    const kill = (pid: number) => {
      try {
        this.deps.kill(pid, sig);
      } catch {
        // already gone
      }
    };
    const table = this.deps.readTable();
    if (!this.exited) {
      const tree = processTree(root, table);
      tree.pids.forEach((p) => this.pids.add(p));
      tree.groups.forEach((g) => this.groups.add(g));
    }
    // recorded processes that still exist, identified by pid and group
    const live = table.filter((p) => this.pids.has(p.pid) && this.groups.has(p.pgid));
    const liveGroups = new Set(live.map((p) => p.pgid));
    if (!this.exited) liveGroups.add(root);
    for (const g of liveGroups) kill(-g);
    for (const p of live) kill(p.pid);
    if (!this.exited) kill(root);
  }
}

/** Process trees started by run() that may still be running. */
const liveTrees = new Set<TreeKiller>();

/**
 * Stops everything run() started that is still running (used on shutdown:
 * children run in their own session, so a Ctrl+C or hangup of this server
 * does not reach them).
 */
export async function stopAllChildren(graceMs = 1_000): Promise<void> {
  const trees = [...liveTrees];
  if (trees.length === 0) return;
  trees.forEach((t) => t.signal("SIGTERM"));
  await sleep(graceMs);
  trees.forEach((t) => t.signal("SIGKILL"));
  liveTrees.clear();
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
    liveTrees.add(killer);

    timers.push(setTimeout(() => {
      timedOut = true;
      killer.signal("SIGTERM");
      // Not in `timers`: SIGKILL must still follow even if run() already
      // returned because the child itself exited (leftovers may ignore SIGTERM).
      setTimeout(() => {
        killer.signal("SIGKILL");
        liveTrees.delete(killer);
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
      if (!timedOut) liveTrees.delete(killer); // after a timeout, the SIGKILL timer still needs it
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
      killer.markExited();
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
