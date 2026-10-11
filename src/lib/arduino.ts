/**
 * arduino-cli wrappers: target resolution, compile, upload, error parsing.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CONFIG_FILENAME, readProjectConfig } from "../project.js";
import { serialBuffer } from "../serial-buffer.js";
import { buildFqbn, getDefaultBoard, getPlatformFamily, loadConfig, type BoardConfig } from "./config.js";
import { ARDUINO_CLI } from "./env.js";
import { run, sleep, type RunResult } from "./exec.js";
import { assertPortAccessible, releasePort } from "./ports.js";
import { assertBuildFlags, assertFqbn, assertSerialPort, sketchDir, UserError } from "./validate.js";

export function cli(args: string[], timeoutMs = 30_000): Promise<RunResult> {
  return run(ARDUINO_CLI, args, { timeoutMs });
}

// ─── Compile output parsing ─────────────────────────────────────────────────

export interface CompileError {
  file: string;
  line: number;
  col: number;
  message: string;
}

export function parseCompileErrors(output: string): CompileError[] {
  const errors: CompileError[] = [];
  // file.ino:LINE:COL: error: MSG | file.cpp:LINE: fatal error: MSG
  const re = /^(.+?):(\d+):(?:(\d+):)?\s+(?:fatal\s+)?error:\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    errors.push({
      file: path.basename(m[1]),
      line: parseInt(m[2], 10),
      col: m[3] ? parseInt(m[3], 10) : 0,
      message: m[4].trim(),
    });
  }
  return errors;
}

/** Linker errors have no "error:" prefix in the usual position. */
function linkerErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => /undefined reference to|multiple definition of|ld returned \d+ exit status/.test(l))
    .map((l) => l.trim());
}

export function formatCompileResult(ok: boolean, output: string, fqbn: string): string {
  const status = `${ok ? "✅" : "❌"} Compile ${ok ? "succeeded" : "failed"} (${fqbn})`;

  if (ok) {
    const size = output.match(/^Sketch uses[^\n]*$/m)?.[0];
    const ram = output.match(/^Global variables use[^\n]*$/m)?.[0];
    return [status, size, ram].filter(Boolean).join("\n");
  }

  const errors = parseCompileErrors(output);
  const linker = linkerErrors(output);
  if (errors.length === 0 && linker.length === 0) {
    return [status, output].filter(Boolean).join("\n").trim();
  }
  return [
    status,
    "",
    "Errors:",
    ...errors.map((e) => `  ❌ ${e.file}:${e.line}${e.col ? ":" + e.col : ""} — ${e.message}`),
    ...linker.map((l) => `  ❌ ${l}`),
  ].join("\n");
}

// ─── Target resolution ──────────────────────────────────────────────────────

export interface Target {
  dir: string;
  fqbn: string;
  family: string;
  uploadPort?: string;
  monitorPort?: string;
  buildFlags: string[];
  board: BoardConfig | null;
  /** Things the user should know about how the target was resolved */
  notes: string[];
}

/** On Windows COM ports are not files, so they cannot be checked this way. */
function portPresent(port: string): boolean {
  return process.platform === "win32" || fs.existsSync(port);
}

/**
 * Resolves what to build and where to upload. Precedence:
 * explicit tool argument > sketch's arduino-mcp.yaml > saved default board.
 */
export async function resolveTarget(
  sketch: string,
  overrides: { fqbn?: string; port?: string } = {}
): Promise<Target> {
  const dir = sketchDir(sketch);
  if (!fs.existsSync(dir)) {
    throw new UserError(`Sketch "${sketch}" not found in ${path.dirname(dir)}.`);
  }
  const [cfg, project] = await Promise.all([loadConfig(), readProjectConfig(sketch)]);
  const board = getDefaultBoard(cfg);

  // v3 project files carry copies of the then-saved board; v3 never used them
  const pinned = project && !project.legacy ? project : null;

  const fqbn = overrides.fqbn || pinned?.fqbn || (board ? buildFqbn(board) : "");
  if (!fqbn) {
    throw new UserError('No board (FQBN) known. Run "detect_board", set one with "board_config", or pass fqbn.');
  }
  assertFqbn(fqbn);

  // Ports are validated in upload(): compiling must not depend on the port.
  // A port pinned in the yaml that is not present (the board re-enumerated)
  // falls back to the saved board's port, which detect_board keeps current.
  const notes: string[] = [];
  const pick = (pinnedPort: string | undefined, savedPort: string | undefined, kind: string) => {
    if (pinnedPort && !portPresent(pinnedPort) && savedPort && portPresent(savedPort)) {
      notes.push(`${CONFIG_FILENAME}: ${kind} port ${pinnedPort} is not connected; using the saved board's ${savedPort}.`);
      return savedPort;
    }
    return pinnedPort || savedPort || undefined;
  };
  const uploadPort = overrides.port || pick(pinned?.upload_port, board?.uploadPort, "upload");
  const monitorPort = pick(pinned?.monitor_port, board?.monitorPort, "monitor");

  return {
    dir,
    fqbn,
    family: getPlatformFamily(fqbn),
    uploadPort,
    monitorPort,
    // the yaml may come from a downloaded sketch: only harmless compiler flags
    buildFlags: assertBuildFlags(project?.build_flags || []),
    board,
    notes,
  };
}

export function compileArgs(t: Target, verbose = false): string[] {
  const args = ["compile", "--fqbn", t.fqbn];
  if (t.buildFlags.length) {
    const flags = t.buildFlags.join(" ");
    args.push("--build-property", `compiler.cpp.extra_flags=${flags}`);
    args.push("--build-property", `compiler.c.extra_flags=${flags}`);
  }
  if (verbose) args.push("--verbose");
  args.push(t.dir);
  return args;
}

export async function compile(t: Target, verbose = false): Promise<{ ok: boolean; text: string }> {
  const r = await cli(compileArgs(t, verbose), 300_000);
  return { ok: r.ok, text: formatCompileResult(r.ok, r.output, t.fqbn) };
}

/**
 * Uploads over serial. Our own serial sessions on the board's ports are paused
 * and resumed afterwards; with freePort, other processes holding the port are
 * stopped (and reported).
 */
export async function upload(t: Target, freePort: boolean): Promise<{ ok: boolean; text: string }> {
  const port = t.uploadPort;
  if (!port) {
    throw new UserError('No upload port known. Run "detect_board", set one with "board_config", or pass port.');
  }
  assertSerialPort(port);
  const notes: string[] = [];
  const resume = await serialBuffer.pause([port, ...(t.monitorPort ? [t.monitorPort] : [])]);
  let r: RunResult;
  try {
    if (freePort) {
      const stopped = await releasePort(port);
      if (stopped.length) {
        notes.push(`Stopped processes holding ${port}: ${stopped.join(", ")}`);
        await sleep(500);
      }
    }
    await assertPortAccessible(port);
    r = await cli(["upload", "--port", port, "--fqbn", t.fqbn, t.dir], 300_000);
  } finally {
    notes.push(...(await resume()));
  }
  notes.unshift(...t.notes);
  const head = `${r.ok ? "✅" : "❌"} Upload ${r.ok ? "succeeded" : "failed"} → ${port}`;
  // On failure show the full arduino-cli/avrdude/esptool output: that is where the reason is.
  return { ok: r.ok, text: [head, r.ok ? "" : r.output, ...notes].filter(Boolean).join("\n") };
}

// ─── esptool ────────────────────────────────────────────────────────────────

function arduinoDataDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Arduino15");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "Arduino15");
  return path.join(os.homedir(), ".arduino15");
}

/** esptool candidates: $ESPTOOL_PATH, PATH (v5 "esptool", v4 "esptool.py"), then the copy bundled with the ESP32 core. */
function esptoolCandidates(): string[] {
  const list: string[] = [];
  if (process.env.ESPTOOL_PATH) list.push(process.env.ESPTOOL_PATH);
  list.push("esptool", "esptool.py");
  const toolsDir = path.join(arduinoDataDir(), "packages", "esp32", "tools", "esptool_py");
  try {
    const versions = fs.readdirSync(toolsDir).sort().reverse();
    for (const v of versions) {
      for (const bin of ["esptool", "esptool.exe", "esptool.py"]) {
        const p = path.join(toolsDir, v, bin);
        if (fs.existsSync(p)) list.push(p);
      }
    }
  } catch {
    // core not installed
  }
  return list;
}

export async function esptool(args: string[], timeoutMs = 60_000): Promise<RunResult> {
  let last: RunResult | null = null;
  for (const bin of esptoolCandidates()) {
    const r = await run(bin, args, { timeoutMs });
    if (r.code !== null || !r.output.startsWith("Command not found")) return r;
    last = r;
  }
  return last ?? { ok: false, code: null, stdout: "", stderr: "esptool not found", output: "esptool not found" };
}
