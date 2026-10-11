/**
 * Saved board settings (~/.arduino-mcp.json) and FQBN building.
 */
import * as fs from "fs/promises";
import { CONFIG_FILE } from "./env.js";
import { UserError, parseBoardOptions } from "./validate.js";

export interface BoardConfig {
  /** Base FQBN (vendor:arch:board) without options; "" when unknown */
  fqbn: string;
  /** avr | esp32 | esp8266 | rp2040 | samd | ... */
  family: string;
  uploadPort: string;
  monitorPort: string;
  // ESP32 menu options
  flashSize?: string;
  psram?: string;
  cdcOnBoot?: string;
  partitionScheme?: string;
  /** ESP32: UploadSpeed, ESP8266: baud */
  uploadSpeed?: string;
  /** Any other board menu options, "key=value,key2=value2" */
  extraOptions?: string;
  boardName?: string;
  lastSeen: string;
}

export interface Config {
  boards: Record<string, BoardConfig>;
  defaultBoard?: string;
}

export async function loadConfig(file = CONFIG_FILE): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { boards: {} };
    throw e;
  }
  try {
    const cfg = JSON.parse(raw) as Config;
    if (!cfg || typeof cfg !== "object" || typeof cfg.boards !== "object" || cfg.boards === null) {
      throw new Error("missing \"boards\" object");
    }
    // Files written by older versions may carry a stale family (e.g. "unknown" for ESP8266).
    for (const b of Object.values(cfg.boards)) {
      if (b.fqbn) b.family = getPlatformFamily(b.fqbn);
    }
    return cfg;
  } catch (e) {
    // Never silently replace a broken file: the next save would wipe the user's settings.
    throw new UserError(`Config file ${file} is not valid (${(e as Error).message}). Fix or delete it, then try again.`);
  }
}

export async function saveConfig(cfg: Config, file = CONFIG_FILE): Promise<void> {
  // Write to a temp file and rename, so a crash never leaves a half-written config.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

export function getDefaultBoard(cfg: Config): BoardConfig | null {
  return cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] ?? null : null;
}

const ARCH_FAMILIES: Record<string, string> = {
  avr: "avr",
  megaavr: "avr",
  samd: "samd",
  sam: "sam",
  esp32: "esp32",
  esp8266: "esp8266",
  rp2040: "rp2040",
  mbed_rp2040: "rp2040",
  mbed_nano: "mbed",
  renesas_uno: "renesas",
};

export function getPlatformFamily(fqbn: string): string {
  const arch = fqbn.split(":")[1];
  if (!arch) return "unknown";
  return ARCH_FAMILIES[arch] || arch;
}

/** Families whose USB-serial chip resets the board when the port is opened (DTR). */
export function resetsOnOpen(family: string | undefined): boolean {
  return family === "avr";
}

export function isEspFamily(family: string | undefined): boolean {
  return family === "esp32" || family === "esp8266";
}

/** Splits "vendor:arch:board:k=v,k2=v2" into the base FQBN and its option string. */
export function splitFqbn(fqbn: string): { base: string; options: string } {
  const parts = fqbn.split(":");
  return { base: parts.slice(0, 3).join(":"), options: parts.slice(3).join(":") };
}

export function buildFqbn(board: BoardConfig): string {
  if (!board.fqbn) return "";
  const opts = new Map<string, string>();

  // Only add menu options that exist for the board family; unknown options
  // make arduino-cli reject the whole FQBN.
  if (board.family === "esp32") {
    if (board.cdcOnBoot) opts.set("CDCOnBoot", board.cdcOnBoot);
    if (board.flashSize) opts.set("FlashSize", board.flashSize);
    if (board.psram) opts.set("PSRAM", board.psram);
    if (board.partitionScheme) opts.set("PartitionScheme", board.partitionScheme);
    if (board.uploadSpeed) opts.set("UploadSpeed", board.uploadSpeed);
  } else if (board.family === "esp8266") {
    if (board.uploadSpeed) opts.set("baud", board.uploadSpeed);
  }
  if (board.extraOptions) {
    for (const [k, v] of parseBoardOptions(board.extraOptions)) opts.set(k, v);
  }

  if (opts.size === 0) return board.fqbn;
  return `${board.fqbn}:${[...opts].map(([k, v]) => `${k}=${v}`).join(",")}`;
}

/** Merges two option strings; keys in `override` win. */
export function mergeOptions(base: string | undefined, override: string | undefined): string | undefined {
  const opts = new Map<string, string>();
  for (const [k, v] of parseBoardOptions(base || "")) opts.set(k, v);
  for (const [k, v] of parseBoardOptions(override || "")) opts.set(k, v);
  return opts.size ? [...opts].map(([k, v]) => `${k}=${v}`).join(",") : undefined;
}
