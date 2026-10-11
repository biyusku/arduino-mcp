/**
 * Arduino project system: per-sketch config (arduino-mcp.yaml) and
 * multi-file sketches.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { parse, stringify } from "yaml";
import { sketchDir, sketchFile, UserError } from "./lib/validate.js";

export interface ArduinoProject {
  name: string;
  description?: string;
  version?: string;
  fqbn?: string;
  upload_port?: string;
  monitor_port?: string;
  baud?: number;
  libraries?: string[];
  build_flags?: string[];
  /**
   * Written by arduino-mcp v3. v3 copied the saved board's fqbn and ports
   * into the file but never used them; they are still ignored, so old files
   * cannot override the board saved with detect_board/board_config.
   */
  legacy?: boolean;
}

export const CONFIG_FILENAME = "arduino-mcp.yaml";
const SOURCE_EXTS = new Set([".ino", ".h", ".hpp", ".c", ".cpp", ".S"]);
const EXTRA_FILES = new Set([CONFIG_FILENAME, "wiring.md", "wiring.svg"]);

const optString = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const optStringList = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);

/** Second header line of every file written by arduino-mcp v3 */
const V3_MARKER = "# https://github.com/birusk/arduino-mcp";

/** The line-based format arduino-mcp v3 wrote: "key: value" and "  - item" lists. */
export function parseV3Yaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && listKey) {
      (result[listKey] as string[]).push(item[1].trim());
      continue;
    }
    listKey = null;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    if (kv[2] === "") {
      result[kv[1]] = [];
      listKey = kv[1];
    } else {
      result[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

export async function readProjectConfig(sketchName: string): Promise<ArduinoProject | null> {
  const file = await sketchFile(sketchName, CONFIG_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  const legacy = content.includes(V3_MARKER);
  let parsed: Record<string, unknown>;
  try {
    parsed = (parse(content) ?? {}) as Record<string, unknown>;
  } catch (e) {
    // v3 wrote values unquoted (e.g. "description: Arduino project: x"), which is not valid YAML
    if (!legacy) throw new UserError(`${CONFIG_FILENAME} in "${sketchName}" is not valid YAML: ${(e as Error).message}`);
    parsed = parseV3Yaml(content);
  }
  const baud = parsed.baud === undefined ? undefined : Number(parsed.baud);
  return {
    ...(legacy ? { legacy: true } : {}),
    name: sketchName,
    description: optString(parsed.description),
    version: optString(parsed.version),
    fqbn: optString(parsed.fqbn),
    upload_port: optString(parsed.upload_port),
    monitor_port: optString(parsed.monitor_port),
    baud: baud !== undefined && Number.isFinite(baud) ? baud : undefined,
    libraries: optStringList(parsed.libraries),
    build_flags: optStringList(parsed.build_flags),
  };
}

export function projectToYaml(config: ArduinoProject): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === "legacy" || v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    clean[k] = v;
  }
  return "# arduino-mcp project config\n" + stringify(clean);
}

export async function writeProjectConfig(sketchName: string, config: ArduinoProject): Promise<string> {
  const file = await sketchFile(sketchName, CONFIG_FILENAME);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, projectToYaml(config), "utf-8");
  return file;
}

/** Lists source files, including Arduino's recursive src/ folder. */
export async function listProjectFiles(sketchName: string): Promise<string[]> {
  const root = sketchDir(sketchName);
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1);
      } else if (SOURCE_EXTS.has(path.extname(e.name)) || (depth === 0 && EXTRA_FILES.has(e.name))) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(root, 0);
  return out.sort();
}

export async function readProjectFile(sketchName: string, filename: string): Promise<string | null> {
  const file = await sketchFile(sketchName, filename);
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

export async function writeProjectFile(sketchName: string, filename: string, content: string): Promise<string> {
  const file = await sketchFile(sketchName, filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf-8");
  return file;
}
