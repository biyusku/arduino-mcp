/**
 * Input validation. Every name, path, port and FQBN coming from a tool call is
 * checked here before it touches the file system or a child process.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { SKETCHES_DIR } from "./env.js";

/** An error whose message is meant to be shown to the user as-is. */
export class UserError extends Error {}

// Same rule as Arduino IDE 2: start with a letter or digit, then letters,
// digits, "_", "-" or "."; at most 63 characters. No path separators.
const SKETCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export function assertSketchName(name: string): string {
  if (!SKETCH_NAME_RE.test(name)) {
    throw new UserError(
      `Invalid sketch name "${name}". Use letters, digits, "_", "-" or ".", ` +
      "start with a letter or digit, max 63 characters."
    );
  }
  return name;
}

export function sketchDir(name: string, baseDir = SKETCHES_DIR): string {
  return path.join(baseDir, assertSketchName(name));
}

/** Resolves a relative path inside baseDir, refusing anything that escapes it. */
export function resolveInside(baseDir: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new UserError(`Invalid file path "${relPath}". Use a path relative to the sketch folder.`);
  }
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relPath);
  const rel = path.relative(base, resolved);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new UserError(`File path "${relPath}" points outside the sketch folder.`);
  }
  return resolved;
}

function isInsideOrSame(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * Like resolveInside, but also refuses paths that leave baseDir through a
 * symbolic link (e.g. a downloaded sketch containing "src -> /home/user" or a
 * dangling "x.h -> ~/.bashrc"). Links that stay inside baseDir are fine.
 */
export async function resolveInsideReal(baseDir: string, relPath: string): Promise<string> {
  const base = path.resolve(baseDir);
  const steps = pathsBelow(base, resolveInside(baseDir, relPath));
  const target = steps[steps.length - 1];
  let realBase: string;
  try {
    realBase = await fs.realpath(base);
  } catch {
    return target; // the folder does not exist yet, so nothing in it can be a link
  }
  for (const p of steps) {
    let isLink: boolean;
    try {
      isLink = (await fs.lstat(p)).isSymbolicLink();
    } catch {
      continue; // does not exist (yet)
    }
    if (!isLink) continue;
    let real: string;
    try {
      real = await fs.realpath(p);
    } catch {
      throw new UserError(`"${relPath}" goes through a broken symbolic link; refusing to follow it.`);
    }
    if (!isInsideOrSame(realBase, real)) {
      throw new UserError(`"${relPath}" leads outside the sketch folder through a symbolic link.`);
    }
  }
  return target;
}

/**
 * Every path from just below `base` down to `target`, spelled with base's
 * letter case. (Walking up from target and comparing strings never ends on
 * Windows, where "..\\Blink\\x" may resolve into base "blink".)
 */
export function pathsBelow(base: string, target: string, p: typeof path.posix = path): string[] {
  const out: string[] = [];
  let current = base;
  for (const segment of p.relative(base, target).split(p.sep).filter(Boolean)) {
    current = p.join(current, segment);
    out.push(current);
  }
  return out;
}

/** A file inside a sketch folder, safe against traversal and symlink escapes. */
export function sketchFile(sketch: string, relPath: string, baseDir = SKETCHES_DIR): Promise<string> {
  return resolveInsideReal(sketchDir(sketch, baseDir), relPath);
}

// ":" appears in stable names such as /dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0
const UNIX_PORT_RE = /^\/dev\/[A-Za-z0-9._\-/:]+$/;
const WIN_PORT_RE = /^(?:\\\\\.\\)?COM\d+$/i;

export function assertSerialPort(port: string): string {
  const ok = (UNIX_PORT_RE.test(port) && !port.split("/").includes("..")) || WIN_PORT_RE.test(port);
  if (!ok) {
    throw new UserError(`Invalid serial port "${port}". Expected something like /dev/ttyACM0, /dev/cu.usbmodem1101 or COM3.`);
  }
  return port;
}

/** Upload ports: serial ports, or arduino-pico's UF2 drive of a Pico in BOOTSEL mode. */
export function assertUploadPort(port: string): string {
  return port === "UF2_Board" ? port : assertSerialPort(port);
}

const FQBN_RE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+)*)?$/;

export function assertFqbn(fqbn: string): string {
  if (!FQBN_RE.test(fqbn)) {
    throw new UserError(`Invalid FQBN "${fqbn}". Expected vendor:arch:board[:key=value,...], e.g. arduino:avr:uno.`);
  }
  return fqbn;
}

const OPTION_RE = /^[A-Za-z0-9_.-]+=[A-Za-z0-9_.-]+$/;

/** Parses "key=value,key2=value2" into pairs, validating each one. */
export function parseBoardOptions(raw: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!OPTION_RE.test(part)) {
      throw new UserError(`Invalid board option "${part}". Expected key=value, e.g. cpu=atmega328old.`);
    }
    const i = part.indexOf("=");
    pairs.push([part.slice(0, i), part.slice(i + 1)]);
  }
  return pairs;
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.\-:]*$/;

export function assertHost(host: string): string {
  if (!HOST_RE.test(host)) {
    throw new UserError(`Invalid IP address or host name "${host}".`);
  }
  return host;
}

export function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError(`Invalid URL "${url}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UserError(`Only http(s) URLs are allowed, got "${url}".`);
  }
  return url;
}

/** Library names are passed after "--", but must still be a single sane token. */
export function assertLibraryName(name: string): string {
  if (!name.trim() || /[\r\n\0]/.test(name) || name.startsWith("-")) {
    throw new UserError(`Invalid library name "${name}".`);
  }
  return name.trim();
}

export function assertPlatformId(id: string): string {
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?$/.test(id)) {
    throw new UserError(`Invalid platform "${id}". Expected vendor:arch, e.g. esp32:esp32 or arduino:avr@1.8.6.`);
  }
  return id;
}

// Compiler flags allowed in arduino-mcp.yaml. Anything that could make the
// compiler run programs or read files (-wrapper, -fplugin=, -Wl,..., -B,
// @file, -include, -I) is refused, and a flag may not contain whitespace,
// quotes or backslashes (they could split into extra flags in the recipe).
const BUILD_FLAG_RES = [
  /^-D[A-Za-z_][A-Za-z0-9_]*(?:=[^\s"'\\]*)?$/, // -DNAME or -DNAME=value
  /^-U[A-Za-z_][A-Za-z0-9_]*$/,
  /^-O[0-3sgz]?$/,
  /^-g[0-3]?$/,
  /^-std=[a-z0-9+]+$/,
  /^-W(?:no-)?[a-z][a-z0-9-]*(?:=[0-9]+)?$/, // warnings; "-Wl,", "-Wa," etc. contain a comma
  /^-f(?:no-)?[a-z][a-z0-9-]*(?:=[0-9]+)?$/, // -fplugin=path has a non-numeric value
  /^-m[a-z][a-z0-9-]*(?:=[A-Za-z0-9_.-]+)?$/,
];

export function assertBuildFlags(flags: string[]): string[] {
  for (const flag of flags) {
    if (!BUILD_FLAG_RES.some((re) => re.test(flag))) {
      throw new UserError(
        `Build flag "${flag}" is not allowed. Use one flag per entry: -DNAME[=value], -UNAME, -O<level>, -g, ` +
        "-std=..., -W<warning>, -f<option>[=<number>] or -m<option>."
      );
    }
  }
  return flags;
}

