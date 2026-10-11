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
    for (const b of Object.values(cfg.boards)) migrateBoard(b);
    return cfg;
  } catch (e) {
    // Never silently replace a broken file: the next save would wipe the user's settings.
    throw new UserError(`Config file ${file} is not valid (${(e as Error).message}). Fix or delete it, then try again.`);
  }
}

let tmpCounter = 0;

/** Brings boards saved by older versions up to date. */
function migrateBoard(b: BoardConfig): void {
  if (!b.fqbn) return;
  // v3 stored "unknown" for some families (e.g. ESP8266)
  b.family = getPlatformFamily(b.fqbn);

  // v3 turned uploadSpeed into "cpu=<value>" for these families (its
  // "cpu_speed" setting). A name like atmega328old was a working option and is
  // kept as cpu=...; a number gave an invalid FQBN and is dropped.
  if (b.uploadSpeed && ["avr", "samd", "rp2040"].includes(b.family)) {
    const value = b.uploadSpeed;
    b.uploadSpeed = undefined;
    if (!/^\d+$/.test(value)) {
      try {
        b.extraOptions = mergeOptions(`cpu=${value}`, b.extraOptions);
      } catch {
        // not a valid option value; the v3 FQBN could not have worked either
      }
    }
  }

  // Options for dedicated fields that ended up in extraOptions move to their field.
  if (b.extraOptions) {
    const raw = b.extraOptions;
    try {
      b.extraOptions = undefined;
      applyBoardOptions(b, raw);
    } catch {
      b.extraOptions = raw;
    }
  }
}

export async function saveConfig(cfg: Config, file = CONFIG_FILE): Promise<void> {
  // Write to a unique temp file and rename, so a crash or a concurrent save
  // never leaves a half-written config.
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf-8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

const updateQueues = new Map<string, Promise<unknown>>();

/**
 * Load → change → save, one at a time per file, so tool calls that run in
 * parallel (e.g. detect_board and board_config) cannot lose each other's
 * changes. Nothing is saved if `change` throws.
 */
export function updateConfig<T>(change: (cfg: Config) => T | Promise<T>, file = CONFIG_FILE): Promise<T> {
  const previous = updateQueues.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    const cfg = await loadConfig(file);
    const result = await change(cfg);
    await saveConfig(cfg, file);
    return result;
  });
  updateQueues.set(file, next.catch(() => {}));
  return next;
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

export type OptionField = "cdcOnBoot" | "flashSize" | "psram" | "partitionScheme" | "uploadSpeed";

/** Board menu options that have their own field, per family (menu key → field). */
const OPTION_FIELDS: Record<string, Record<string, OptionField>> = {
  esp32: { CDCOnBoot: "cdcOnBoot", FlashSize: "flashSize", PSRAM: "psram", PartitionScheme: "partitionScheme", UploadSpeed: "uploadSpeed" },
  esp8266: { baud: "uploadSpeed" },
};

/** The FQBN menu key of a field for this family, or undefined if the field does not apply. */
export function optionKey(family: string, field: OptionField): string | undefined {
  return Object.entries(OPTION_FIELDS[family] ?? {}).find(([, f]) => f === field)?.[0];
}

function formatOptions(opts: Map<string, string>): string | undefined {
  return opts.size ? [...opts].map(([k, v]) => `${k}=${v}`).join(",") : undefined;
}

/**
 * Applies "key=value,..." menu options: options that have their own field
 * (e.g. PSRAM on ESP32) go there, all others into extraOptions.
 */
export function applyBoardOptions(board: BoardConfig, raw: string): void {
  const fields = OPTION_FIELDS[board.family] ?? {};
  const extra = new Map(parseBoardOptions(board.extraOptions || ""));
  for (const [k, v] of parseBoardOptions(raw)) {
    const field = fields[k];
    if (field) {
      board[field] = v;
      extra.delete(k);
    } else {
      extra.set(k, v);
    }
  }
  board.extraOptions = formatOptions(extra);
}

/** Sets or clears one option field, dropping the same key from extraOptions so the two never disagree. */
export function setBoardOption(board: BoardConfig, field: OptionField, value: string | undefined): void {
  board[field] = value;
  const key = optionKey(board.family, field);
  if (key && board.extraOptions) {
    const extra = new Map(parseBoardOptions(board.extraOptions));
    extra.delete(key);
    board.extraOptions = formatOptions(extra);
  }
}

export function buildFqbn(board: BoardConfig): string {
  if (!board.fqbn) return "";
  const opts = new Map<string, string>();

  // Only add menu options that exist for the board family; unknown options
  // make arduino-cli reject the whole FQBN.
  for (const [key, field] of Object.entries(OPTION_FIELDS[board.family] ?? {})) {
    const value = board[field];
    if (value) opts.set(key, value);
  }
  if (board.extraOptions) {
    for (const [k, v] of parseBoardOptions(board.extraOptions)) opts.set(k, v);
  }

  if (opts.size === 0) return board.fqbn;
  return `${board.fqbn}:${formatOptions(opts)}`;
}

/** Merges two option strings; keys in `override` win. */
export function mergeOptions(base: string | undefined, override: string | undefined): string | undefined {
  const opts = new Map<string, string>();
  for (const [k, v] of parseBoardOptions(base || "")) opts.set(k, v);
  for (const [k, v] of parseBoardOptions(override || "")) opts.set(k, v);
  return opts.size ? [...opts].map(([k, v]) => `${k}=${v}`).join(",") : undefined;
}
