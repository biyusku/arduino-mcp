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
}

export const CONFIG_FILENAME = "arduino-mcp.yaml";
const SOURCE_EXTS = new Set([".ino", ".h", ".hpp", ".c", ".cpp", ".S"]);
const EXTRA_FILES = new Set([CONFIG_FILENAME, "wiring.md", "wiring.svg"]);

const optString = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const optStringList = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);

export async function readProjectConfig(sketchName: string): Promise<ArduinoProject | null> {
  const file = await sketchFile(sketchName, CONFIG_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = (parse(content) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new UserError(`${CONFIG_FILENAME} in "${sketchName}" is not valid YAML: ${(e as Error).message}`);
  }
  const baud = parsed.baud === undefined ? undefined : Number(parsed.baud);
  return {
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
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
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
