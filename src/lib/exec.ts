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
}

export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(file, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      output += s;
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      output += s;
    });

    const finish = (code: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(null, err.code === "ENOENT" ? `Command not found: ${file}` : err.message);
    });
    child.on("close", (code) => {
      finish(code, timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : undefined);
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
