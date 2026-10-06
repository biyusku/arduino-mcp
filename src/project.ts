/**
 * Arduino Project System
 * Supports multi-file sketches, project config (arduino-mcp.yaml),
 * and external library dependencies.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

export interface ArduinoProject {
  name: string;
  fqbn?: string;
  upload_port?: string;
  monitor_port?: string;
  baud?: number;
  libraries?: string[];
  build_flags?: string[];
  description?: string;
  version?: string;
}

const SKETCHES_DIR = process.env.ARDUINO_SKETCHES_DIR || path.join(os.homedir(), "Arduino");
const CONFIG_FILENAME = "arduino-mcp.yaml";

// Minimal YAML parser for our simple config format
function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let currentKey = "";
  let currentArray: string[] = [];
  let inArray = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    const arrayItem = line.match(/^  - (.+)$/);
    if (arrayItem && inArray) {
      currentArray.push(arrayItem[1].trim());
      continue;
    }

    if (inArray) {
      result[currentKey] = currentArray;
      inArray = false;
      currentArray = [];
    }

    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === "" || val === "[]") {
        currentArray = [];
        inArray = val === "" ? false : false;
        if (val === "") {
          inArray = true;
          currentArray = [];
        }
      } else {
        result[currentKey] = val.replace(/^["']|["']$/g, "");
      }
    }
  }

  if (inArray) result[currentKey] = currentArray;
  return result;
}

// Minimal YAML serializer
function toYaml(obj: ArduinoProject): string {
  const lines: string[] = ["# arduino-mcp project config", "# https://github.com/birusk/arduino-mcp", ""];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of val) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function readProjectConfig(sketchName: string): Promise<ArduinoProject | null> {
  const configPath = path.join(SKETCHES_DIR, sketchName, CONFIG_FILENAME);
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content);
    return {
      name: sketchName,
      fqbn: parsed.fqbn as string | undefined,
      upload_port: parsed.upload_port as string | undefined,
      monitor_port: parsed.monitor_port as string | undefined,
      baud: parsed.baud ? parseInt(parsed.baud as string) : undefined,
      libraries: parsed.libraries as string[] | undefined,
      build_flags: parsed.build_flags as string[] | undefined,
      description: parsed.description as string | undefined,
      version: parsed.version as string | undefined,
    };
  } catch {
    return null;
  }
}

export async function writeProjectConfig(sketchName: string, config: ArduinoProject): Promise<void> {
  const dir = path.join(SKETCHES_DIR, sketchName);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, CONFIG_FILENAME);
  await fs.writeFile(configPath, toYaml(config), "utf-8");
}

export async function listProjectFiles(sketchName: string): Promise<string[]> {
  const dir = path.join(SKETCHES_DIR, sketchName);
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((f) =>
      f.endsWith(".ino") || f.endsWith(".h") || f.endsWith(".cpp") || f.endsWith(".c") || f === CONFIG_FILENAME
    );
  } catch {
    return [];
  }
}

export async function readProjectFile(sketchName: string, filename: string): Promise<string | null> {
  const filePath = path.join(SKETCHES_DIR, sketchName, filename);
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function writeProjectFile(sketchName: string, filename: string, content: string): Promise<void> {
  const dir = path.join(SKETCHES_DIR, sketchName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, "utf-8");
}
