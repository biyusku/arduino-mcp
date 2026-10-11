/**
 * Process helpers. Commands are always started without a shell and with an
 * argument array, so user/LLM supplied values can never be interpreted as
 * shell syntax.
 */
import { spawn } from "child_process";
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

/**
 * Kills a child and everything it started (e.g. avrdude/esptool under
 * arduino-cli), so nothing keeps holding the serial port after a timeout.
 */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, signal); // the child leads its own process group (detached)
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
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

    timers.push(setTimeout(() => {
      timedOut = true;
      killTree(child.pid, "SIGTERM");
      timers.push(setTimeout(() => {
        killTree(child.pid, "SIGKILL");
        finish(null, timeoutNote());
      }, killGraceMs));
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
