#!/usr/bin/env node
/**
 * arduino-mcp v3.2.0
 * Universal MCP server for Arduino IDE & arduino-cli
 * Supports: AVR (Uno/Mega/Nano), ESP32, ESP32-S3, ESP8266, RP2040, STM32, and more
 * https://github.com/birusk/arduino-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as fss from "fs";
import * as path from "path";
import * as os from "os";
import { serialBuffer } from "./serial-buffer.js";
import {
  readProjectConfig, writeProjectConfig,
  listProjectFiles, readProjectFile, writeProjectFile,
  type ArduinoProject,
} from "./project.js";

const execAsync = promisify(exec);

// ─── Constants ───────────────────────────────────────────────────────────────

const ARDUINO_CLI = process.env.ARDUINO_CLI_PATH || "arduino-cli";
const SKETCHES_DIR = process.env.ARDUINO_SKETCHES_DIR || path.join(os.homedir(), "Arduino");
const CONFIG_FILE = path.join(os.homedir(), ".arduino-mcp.json");

// USB-UART bridge chips → upload port only
const UPLOAD_VENDORS = new Set([
  "1a86", // CH340/CH341/CH343 (most ESP32/Arduino clones)
  "10c4", // CP2102 (Silicon Labs)
  "0403", // FTDI FT232
  "2341", // Official Arduino (Uno R3, Mega etc via ATmega16U2)
  "2a03", // Arduino.org
  "1b4f", // Sparkfun
  "239a", // Adafruit
]);

// Native USB devices — monitor port (or upload via USB DFU/CDC)
const NATIVE_USB_VENDORS = new Set([
  "303a", // Espressif native (ESP32-S2/S3)
  "2341", // Arduino native USB (Leonardo, Micro, Zero) — also in UPLOAD_VENDORS for Uno
  "2a03", // Arduino.org native
  "1b4f", // Sparkfun native
  "239a", // Adafruit native
  "2e8a", // Raspberry Pi (RP2040)
]);

// Platform families
const PLATFORM_FAMILIES: Record<string, string> = {
  "arduino:avr": "avr",
  "arduino:megaavr": "avr",
  "arduino:samd": "samd",
  "arduino:sam": "sam",
  "arduino:mbed": "mbed",
  "arduino:mbed_rp2040": "rp2040",
  "esp32:esp32": "esp32",
  "arduino:esp32": "esp32",
  "rp2040:rp2040": "rp2040",
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface BoardConfig {
  fqbn: string;
  family: string; // avr | esp32 | rp2040 | samd | ...
  uploadPort: string;
  monitorPort: string;
  flashSize?: string;
  psram?: string;
  cdcOnBoot?: string;
  uploadSpeed?: string;
  partitionScheme?: string;
  boardName?: string;
  lastSeen: string;
}

interface Config {
  boards: Record<string, BoardConfig>;
  defaultBoard?: string;
}

interface CompileError {
  file: string;
  line: number;
  col: number;
  message: string;
}

interface DetectedPort {
  port: string;
  vendor: string;
  product: string;
  serial: string;
  modelName: string;
  role: "upload" | "monitor" | "both";
  isNativeUSB: boolean;
}

// ─── Config helpers ──────────────────────────────────────────────────────────

async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { boards: {} };
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

function getPlatformFamily(fqbn: string): string {
  const prefix = fqbn.split(":").slice(0, 2).join(":");
  return PLATFORM_FAMILIES[prefix] || "unknown";
}

function buildFqbn(board: BoardConfig): string {
  // AVR boards don't support ESP32-specific options
  if (board.family === "avr" || board.family === "samd" || board.family === "rp2040") {
    const opts: string[] = [];
    if (board.uploadSpeed) opts.push(`cpu=${board.uploadSpeed}`);
    return opts.length > 0 ? `${board.fqbn}:${opts.join(",")}` : board.fqbn;
  }

  // ESP32 family options
  const opts: string[] = [];
  if (board.cdcOnBoot) opts.push(`CDCOnBoot=${board.cdcOnBoot}`);
  if (board.flashSize) opts.push(`FlashSize=${board.flashSize}`);
  if (board.psram) opts.push(`PSRAM=${board.psram}`);
  if (board.partitionScheme) opts.push(`PartitionScheme=${board.partitionScheme}`);
  if (board.uploadSpeed) opts.push(`UploadSpeed=${board.uploadSpeed}`);
  return opts.length > 0 ? `${board.fqbn}:${opts.join(",")}` : board.fqbn;
}

function getDefaultBoardSettings(fqbn: string): Partial<BoardConfig> {
  const family = getPlatformFamily(fqbn);
  const isS3 = fqbn.includes("s3");
  const isS2 = fqbn.includes("s2");
  const isC3 = fqbn.includes("c3");

  if (family === "esp32") {
    return {
      family,
      cdcOnBoot: (isS3 || isS2 || isC3) ? "default" : undefined,
      flashSize: "4M",
      psram: isS3 ? "opi" : isS2 ? "qspi" : undefined,
      uploadSpeed: "921600",
    };
  }

  return { family };
}

// ─── Shell helpers ───────────────────────────────────────────────────────────

async function runCmd(
  cmd: string,
  timeout = 30000
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout?.trim() || "",
      stderr: e.stderr?.trim() || e.message || String(err),
      ok: false,
    };
  }
}

async function ensureSketchDir(name: string): Promise<string> {
  const dir = path.join(SKETCHES_DIR, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function freePort(port: string): Promise<void> {
  return new Promise((resolve) => {
    exec(`fuser -k ${port} 2>/dev/null`, () => resolve());
  });
}

async function fixPortPermission(port: string): Promise<void> {
  const r = await runCmd(`chmod 666 ${port} 2>/dev/null`);
  if (!r.ok) await runCmd(`sudo chmod 666 ${port} 2>/dev/null`);
}

// ─── Compile error parser ────────────────────────────────────────────────────

function parseCompileErrors(output: string): CompileError[] {
  const errors: CompileError[] = [];
  // Handles both: file.ino:LINE:COL: error: MSG and file.cpp:LINE: error: MSG
  const re = /^(.+?):(\d+):(?:(\d+):)?\s+error:\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    errors.push({
      file: path.basename(m[1]),
      line: parseInt(m[2]),
      col: m[3] ? parseInt(m[3]) : 0,
      message: m[4].trim(),
    });
  }
  return errors;
}

function formatCompileResult(ok: boolean, stdout: string, stderr: string, fqbn: string): string {
  const combined = stdout + "\n" + stderr;
  const errors = parseCompileErrors(combined);
  const icon = ok ? "✅" : "❌";
  const status = `${icon} Derleme ${ok ? "başarılı" : "başarısız"} (${fqbn})`;

  if (ok) {
    // Extract size info
    const sizeMatch = combined.match(/Sketch uses[\s\S]*?Maximum is[^\n]*/g);
    return [status, sizeMatch ? sizeMatch[0] : ""].filter(Boolean).join("\n");
  }

  if (errors.length > 0) {
    const errLines = errors.map((e) =>
      `  ❌ ${e.file}:${e.line}${e.col ? ":" + e.col : ""} — ${e.message}`
    );
    return [status, "\nHatalar:", ...errLines].join("\n");
  }

  return [status, combined].filter(Boolean).join("\n").trim();
}

// ─── Auto-detect ports ────────────────────────────────────────────────────────

async function detectPorts(): Promise<DetectedPort[]> {
  const devList = await runCmd("ls /dev/ttyACM* /dev/ttyUSB* /dev/ttyS[0-9]* 2>/dev/null");
  if (!devList.stdout) return [];

  const ports: DetectedPort[] = [];
  for (const port of devList.stdout.split("\n").filter(Boolean)) {
    // Skip bare ttyS ports that have no USB backing
    if (port.match(/\/dev\/ttyS\d+$/)) {
      const udevCheck = await runCmd(`udevadm info --query=property --name=${port} 2>/dev/null | grep ID_BUS`);
      if (!udevCheck.stdout.includes("usb")) continue;
    }

    const udev = await runCmd(`udevadm info --query=all --name=${port} 2>/dev/null`);
    if (!udev.ok) continue;

    const vendor = udev.stdout.match(/ID_VENDOR_ID=([0-9a-f]+)/i)?.[1]?.toLowerCase() || "";
    const product = udev.stdout.match(/ID_MODEL_ID=([0-9a-f]+)/i)?.[1]?.toLowerCase() || "";
    const serial = udev.stdout.match(/ID_SERIAL_SHORT=([^\n]+)/)?.[1]?.trim() || "";
    const modelName = udev.stdout.match(/ID_MODEL=([^\n]+)/)?.[1]?.trim().replace(/_/g, " ") || "";

    if (!vendor) continue;

    const isUploadVendor = UPLOAD_VENDORS.has(vendor);
    const isNativeUSB = NATIVE_USB_VENDORS.has(vendor);

    // Determine role:
    // - Pure UART bridges (CH340 etc) with product not matching Arduino native → upload only
    // - ESP32-S3 native USB (303a) → monitor only (upload via UART bridge)
    // - Arduino Leonardo/Micro/Zero native USB → both (single port)
    // - Standard Arduino Uno via ATmega16U2 (2341:0043 etc) → both
    let role: DetectedPort["role"] = "both";

    if (vendor === "1a86") {
      // CH340/CH341/CH343 — pure UART bridge, upload only
      role = "upload";
    } else if (vendor === "303a") {
      // Espressif native USB — monitor only (paired with CH343 for upload)
      role = "monitor";
    } else if (vendor === "2341" || vendor === "2a03") {
      // Could be Uno (ATmega16U2, both) or Leonardo (native, both)
      role = "both";
    }

    ports.push({ port, vendor, product, serial, modelName, role, isNativeUSB });
  }
  return ports;
}

async function autoDetect(): Promise<{
  uploadPort: string;
  monitorPort: string;
  serial: string;
  fqbn?: string;
  boardName?: string;
} | null> {
  const ports = await detectPorts();
  if (ports.length === 0) return null;

  // Prefer dedicated upload port, fall back to "both"
  const uploadPort =
    ports.find((p) => p.role === "upload") ||
    ports.find((p) => p.role === "both");

  const monitorPort =
    ports.find((p) => p.role === "monitor") ||
    ports.find((p) => p.role === "both");

  if (!uploadPort && !monitorPort) return null;

  const up = uploadPort || monitorPort!;
  const mp = monitorPort || uploadPort!;

  // Try arduino-cli board list for FQBN
  const boardList = await runCmd(`${ARDUINO_CLI} board list 2>/dev/null`);
  let fqbn: string | undefined;
  let boardName: string | undefined;

  if (boardList.ok) {
    for (const line of boardList.stdout.split("\n")) {
      if (line.includes(up.port) || line.includes(mp.port)) {
        const match = line.match(/([\w-]+:[\w-]+:[\w-]+)/);
        if (match) fqbn = match[0];
        const parts = line.trim().split(/\s{2,}/);
        if (parts.length >= 3) boardName = parts[2];
      }
    }
  }

  return {
    uploadPort: up.port,
    monitorPort: mp.port,
    serial: up.serial || mp.serial || `${up.vendor}:${up.product}`,
    fqbn,
    boardName,
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "arduino-mcp",
  version: "3.1.0",
});

// ════════════════════════════════════════════════════════════════════════════
// BOARD TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "detect_board",
  "Bağlı kartı otomatik tanır ve hafızaya kaydeder. AVR (Uno/Mega/Nano), ESP32, ESP32-S3, RP2040, SAMD ve tüm diğer Arduino kartları desteklenir. ESP32-S3 dual-USB'yi otomatik çözer.",
  { save: z.boolean().default(true).describe("Kartı hafızaya kaydet") },
  async ({ save }) => {
    const detected = await autoDetect();
    if (!detected) {
      return {
        content: [{ type: "text", text: "❌ Bağlı kart bulunamadı.\n\nKontrol et:\n• USB kablosu takılı mı?\n• Kablo data destekliyor mu? (sadece şarj değil)\n• COM portuna takılı mı? (ESP32-S3 için)" }],
      };
    }

    let savedMsg = "";
    if (save) {
      const serial = detected.serial || `unknown_${Date.now()}`;
      const cfg = await loadConfig();
      const baseFqbn = detected.fqbn?.split(":").slice(0, 3).join(":") || "esp32:esp32:esp32s3";
      const defaults = getDefaultBoardSettings(baseFqbn);

      cfg.boards[serial] = {
        fqbn: baseFqbn,
        family: defaults.family || "unknown",
        uploadPort: detected.uploadPort,
        monitorPort: detected.monitorPort,
        boardName: detected.boardName,
        ...defaults,
        lastSeen: new Date().toISOString(),
      };
      cfg.defaultBoard = serial;
      await saveConfig(cfg);
      savedMsg = "\n✅ Kart hafızaya kaydedildi.";
    }

    const samePort = detected.uploadPort === detected.monitorPort;
    return {
      content: [{
        type: "text",
        text: [
          "🔍 Kart Tespit Edildi",
          `Kart:         ${detected.boardName || "Bilinmiyor"}`,
          `FQBN:         ${detected.fqbn || "Tespit edilemedi"}`,
          samePort
            ? `Port:         ${detected.uploadPort} (upload + monitor)`
            : `Upload Port:  ${detected.uploadPort}`,
          samePort ? "" : `Monitor Port: ${detected.monitorPort}`,
          `Seri No:      ${detected.serial || "Bilinmiyor"}`,
          savedMsg,
        ].filter((l) => l !== undefined && l !== "").join("\n"),
      }],
    };
  }
);

server.tool(
  "board_config",
  "Kayıtlı kart ayarlarını göster veya güncelle. AVR'de cpu_speed, ESP32'de flash/psram/cdc/partition desteklenir.",
  {
    action: z.enum(["show", "set"]).default("show"),
    fqbn: z.string().optional().describe("Kart FQBN (ör: arduino:avr:uno, esp32:esp32:esp32s3)"),
    upload_port: z.string().optional().describe("Upload portu"),
    monitor_port: z.string().optional().describe("Monitor portu"),
    flash_size: z.string().optional().describe("Flash (ESP32 only): 2M | 4M | 8M | 16M"),
    psram: z.string().optional().describe("PSRAM (ESP32 only): opi | qspi | disabled"),
    cdc_on_boot: z.string().optional().describe("CDCOnBoot (ESP32-S3/S2 only): default | cdc"),
    partition_scheme: z.string().optional().describe("Partition (ESP32 only): default | huge_app | min_spiffs | no_ota"),
    upload_speed: z.string().optional().describe("Upload hızı: 921600 | 460800 | 115200"),
  },
  async ({ action, fqbn, upload_port, monitor_port, flash_size, psram, cdc_on_boot, partition_scheme, upload_speed }) => {
    const cfg = await loadConfig();

    if (action === "show") {
      if (!cfg.defaultBoard || !cfg.boards[cfg.defaultBoard]) {
        return { content: [{ type: "text", text: '❌ Kayıtlı kart yok. Önce "detect_board" çalıştır.' }] };
      }
      const b = cfg.boards[cfg.defaultBoard];
      const isAvr = b.family === "avr";
      return {
        content: [{
          type: "text",
          text: [
            "📋 Kayıtlı Kart Ayarları",
            `Seri No:        ${cfg.defaultBoard}`,
            `Kart:           ${b.boardName || "Bilinmiyor"}`,
            `Platform:       ${b.family}`,
            `FQBN:           ${buildFqbn(b)}`,
            `Upload Port:    ${b.uploadPort}`,
            `Monitor Port:   ${b.monitorPort}`,
            isAvr ? null : `Flash:          ${b.flashSize || "varsayılan"}`,
            isAvr ? null : `PSRAM:          ${b.psram || "yok"}`,
            isAvr ? null : `CDC on Boot:    ${b.cdcOnBoot || "varsayılan"}`,
            isAvr ? null : `Partition:      ${b.partitionScheme || "varsayılan"}`,
            `Upload Speed:   ${b.uploadSpeed || "varsayılan"}`,
            `Son Görülme:    ${b.lastSeen}`,
          ].filter((l) => l !== null).join("\n"),
        }],
      };
    }

    if (!cfg.defaultBoard) {
      return { content: [{ type: "text", text: '❌ Önce "detect_board" çalıştır.' }] };
    }
    const b = cfg.boards[cfg.defaultBoard];
    if (fqbn) { b.fqbn = fqbn.split(":").slice(0, 3).join(":"); b.family = getPlatformFamily(b.fqbn); }
    if (upload_port) b.uploadPort = upload_port;
    if (monitor_port) b.monitorPort = monitor_port;
    if (flash_size) b.flashSize = flash_size;
    if (psram) b.psram = psram;
    if (cdc_on_boot) b.cdcOnBoot = cdc_on_boot;
    if (partition_scheme) b.partitionScheme = partition_scheme;
    if (upload_speed) b.uploadSpeed = upload_speed;
    b.lastSeen = new Date().toISOString();
    await saveConfig(cfg);

    return {
      content: [{
        type: "text",
        text: `✅ Ayarlar güncellendi.\nFQBN: ${buildFqbn(b)}\nUpload: ${b.uploadPort} | Monitor: ${b.monitorPort}`,
      }],
    };
  }
);

server.tool(
  "board_options",
  "Bir kart için mevcut tüm FQBN seçeneklerini listeler (flash, psram, cpu speed, bootloader vb.)",
  { fqbn: z.string().optional().describe("Kart FQBN (opsiyonel, belirtilmezse kayıtlı kart)") },
  async ({ fqbn }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? board.fqbn : null);
    if (!resolvedFqbn) {
      return { content: [{ type: "text", text: '❌ FQBN bulunamadı. Önce "detect_board" çalıştır.' }] };
    }
    const r = await runCmd(`${ARDUINO_CLI} board details --fqbn ${resolvedFqbn} 2>&1`);
    return { content: [{ type: "text", text: r.stdout || r.stderr }] };
  }
);

server.tool(
  "list_boards",
  "Bağlı tüm kartları ve portlarını listeler. Upload/monitor rollerini ayrı gösterir.",
  {},
  async () => {
    const ports = await detectPorts();
    const cliList = await runCmd(`${ARDUINO_CLI} board list 2>&1`);
    const lines: string[] = ["🔌 Tespit Edilen Portlar:\n"];
    if (ports.length === 0) {
      lines.push("  Bağlı cihaz yok.");
    } else {
      for (const p of ports) {
        const roleLabel = p.role === "upload" ? "📤 upload" : p.role === "monitor" ? "📡 monitor" : "📤📡 upload+monitor";
        lines.push(`  ${p.port}  [${roleLabel}]  ${p.modelName || p.vendor + ":" + p.product}  SN:${p.serial || "?"}`);
      }
    }
    if (cliList.ok && cliList.stdout) {
      lines.push("\n📋 arduino-cli board list:");
      lines.push(cliList.stdout);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "board_info",
  "Bağlı kartın detaylı bilgisini gösterir (chip, flash, MAC, revision)",
  { port: z.string().optional().describe("Port (opsiyonel)") },
  async ({ port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.uploadPort || "/dev/ttyACM0";
    await fixPortPermission(resolvedPort);
    const r = await runCmd(`${ARDUINO_CLI} board info --port ${resolvedPort} 2>&1`);
    if (r.ok && r.stdout) return { content: [{ type: "text", text: r.stdout }] };
    const udev = await runCmd(`udevadm info --query=all --name=${resolvedPort} 2>&1 | grep -E "ID_VENDOR|ID_MODEL|ID_SERIAL|ID_USB"`);
    return { content: [{ type: "text", text: udev.stdout || "Kart bilgisi alınamadı." }] };
  }
);

server.tool(
  "erase_flash",
  "ESP32/ESP8266 flash belleğini tamamen siler. NOT: AVR kartlar için desteklenmez.",
  { port: z.string().optional().describe("Port (opsiyonel)") },
  async ({ port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;

    if (board && board.family === "avr") {
      return { content: [{ type: "text", text: "❌ Flash silme AVR kartlar için desteklenmiyor. Arduino Uno/Mega/Nano'da erase_flash kullanılamaz." }] };
    }

    const resolvedPort = port || board?.uploadPort || "/dev/ttyACM0";
    await freePort(resolvedPort);
    await fixPortPermission(resolvedPort);
    const r = await runCmd(`esptool.py --port ${resolvedPort} erase_flash 2>&1`, 60000);
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{ type: "text", text: `${icon} Flash silme ${r.ok ? "tamamlandı" : "başarısız"}:\n${r.stdout}\n${r.stderr}`.trim() }],
    };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// SKETCH TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "list_sketches",
  "~/Arduino klasöründeki tüm sketch'leri son değiştirme tarihleriyle listeler",
  {},
  async () => {
    try {
      await fs.mkdir(SKETCHES_DIR, { recursive: true });
      const entries = await fs.readdir(SKETCHES_DIR, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length === 0) return { content: [{ type: "text", text: "Henüz hiç sketch yok." }] };
      const lines = await Promise.all(
        dirs.map(async (d) => {
          const inoFile = path.join(SKETCHES_DIR, d.name, `${d.name}.ino`);
          try {
            const stat = await fs.stat(inoFile);
            return `  • ${d.name.padEnd(32)} ${stat.mtime.toLocaleDateString("tr-TR")}`;
          } catch {
            return `  • ${d.name}`;
          }
        })
      );
      return { content: [{ type: "text", text: `Sketch'ler (${SKETCHES_DIR}):\n${lines.join("\n")}` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Hata: ${(e as Error).message}` }] };
    }
  }
);

server.tool(
  "create_sketch",
  "Yeni Arduino sketch'i oluşturur. Şablonlar: blink, wifi, mqtt, sensor, servo, i2c_scan, empty, custom",
  {
    name: z.string().describe("Sketch adı"),
    template: z.enum(["blink", "wifi", "mqtt", "sensor", "servo", "i2c_scan", "empty", "custom"]).default("blink"),
    code: z.string().optional().describe("Özel kod (template=custom için)"),
  },
  async ({ name, template, code }) => {
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
    const dir = await ensureSketchDir(safeName);
    const file = path.join(dir, `${safeName}.ino`);

    const templates: Record<string, string> = {
      empty: `// ${safeName}\n\nvoid setup() {\n}\n\nvoid loop() {\n}\n`,
      blink: `// ${safeName} — Blink
// Works on: Uno, Mega, Nano (pin 13), ESP32 (pin 2)
#ifndef LED_BUILTIN
  #define LED_BUILTIN 2
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("${safeName} started!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`,
      wifi: `// ${safeName} — WiFi Connect (ESP32/ESP8266)
#include <WiFi.h>

const char* ssid     = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected! IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  delay(1000);
}
`,
      mqtt: `// ${safeName} — MQTT (ESP32)
#include <WiFi.h>
#include <PubSubClient.h>

const char* ssid        = "YOUR_SSID";
const char* password    = "YOUR_PASSWORD";
const char* mqtt_server = "broker.hivemq.com";
const int topic_in  = "devices/esp32/cmd";
const char* topic_out = "devices/esp32/data";

WiFiClient   espClient;
PubSubClient client(espClient);

void callback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.println("MSG [" + String(topic) + "]: " + msg);
}

void reconnect() {
  while (!client.connected()) {
    if (client.connect("ESP32Client")) {
      client.subscribe(topic_in);
      Serial.println("MQTT connected");
    } else {
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  Serial.print("IP: "); Serial.println(WiFi.localIP());
  client.setServer(mqtt_server, 1883);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();
  static unsigned long last = 0;
  if (millis() - last > 5000) {
    last = millis();
    client.publish(topic_out, String(millis()).c_str());
  }
}
`,
      sensor: `// ${safeName} — Analog Sensor Read
// Works on: Uno (A0-A5), ESP32 (34,35,36,39)
#ifdef ESP32
  #define SENSOR_PIN 34
#else
  #define SENSOR_PIN A0
#endif

void setup() {
  Serial.begin(115200);
  Serial.println("Sensor ready");
}

void loop() {
  int raw = analogRead(SENSOR_PIN);
  #ifdef ESP32
    float v = raw * (3.3f / 4095.0f);
  #else
    float v = raw * (5.0f / 1023.0f);
  #endif
  Serial.print("Raw: "); Serial.print(raw);
  Serial.print("  V: "); Serial.println(v, 2);
  delay(1000);
}
`,
      servo: `// ${safeName} — Servo Control
#include <Servo.h>

Servo myServo;
const int SERVO_PIN = 9;  // Uno: 9, ESP32: any PWM pin

void setup() {
  Serial.begin(115200);
  myServo.attach(SERVO_PIN);
  Serial.println("Servo ready. Send 0-180 via Serial.");
}

void loop() {
  if (Serial.available()) {
    int angle = Serial.parseInt();
    if (angle >= 0 && angle <= 180) {
      myServo.write(angle);
      Serial.print("Angle: "); Serial.println(angle);
    }
  }
}
`,
      i2c_scan: `// ${safeName} — I2C Scanner
// Finds all I2C devices on the bus
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Serial.println("I2C Scanner started");

  byte count = 0;
  for (byte addr = 8; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("Found device at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      count++;
    }
  }
  Serial.print("Total devices: "); Serial.println(count);
}

void loop() {}
`,
    };

    const finalCode = (template === "custom" && code) ? code : (templates[template] || templates.blink);
    await fs.writeFile(file, finalCode, "utf-8");
    return {
      content: [{ type: "text", text: `✅ Sketch oluşturuldu: ${file}\n\n\`\`\`cpp\n${finalCode}\n\`\`\`` }],
    };
  }
);

server.tool(
  "read_sketch",
  "Bir sketch'in kaynak kodunu okur",
  { name: z.string().describe("Sketch adı") },
  async ({ name }) => {
    const file = path.join(SKETCHES_DIR, name, `${name}.ino`);
    try {
      const code = await fs.readFile(file, "utf-8");
      return { content: [{ type: "text", text: `📄 ${file}:\n\`\`\`cpp\n${code}\n\`\`\`` }] };
    } catch {
      return { content: [{ type: "text", text: `❌ Sketch bulunamadı: ${file}` }] };
    }
  }
);

server.tool(
  "write_sketch",
  "Bir sketch'in kodunu günceller veya oluşturur",
  {
    name: z.string().describe("Sketch adı"),
    code: z.string().describe("Arduino kodu"),
  },
  async ({ name, code }) => {
    const dir = await ensureSketchDir(name);
    const file = path.join(dir, `${name}.ino`);
    await fs.writeFile(file, code, "utf-8");
    return { content: [{ type: "text", text: `✅ Sketch güncellendi: ${file}` }] };
  }
);

server.tool(
  "delete_sketch",
  "Bir sketch klasörünü tamamen siler",
  { name: z.string().describe("Silinecek sketch adı") },
  async ({ name }) => {
    const dir = path.join(SKETCHES_DIR, name);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return { content: [{ type: "text", text: `✅ Sketch silindi: ${dir}` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Silinemedi: ${(e as Error).message}` }] };
    }
  }
);

server.tool(
  "rename_sketch",
  "Bir sketch'i yeniden adlandırır",
  {
    old_name: z.string().describe("Mevcut sketch adı"),
    new_name: z.string().describe("Yeni sketch adı"),
  },
  async ({ old_name, new_name }) => {
    const oldDir = path.join(SKETCHES_DIR, old_name);
    const newDir = path.join(SKETCHES_DIR, new_name);
    try {
      await fs.rename(oldDir, newDir);
      try {
        await fs.rename(
          path.join(newDir, `${old_name}.ino`),
          path.join(newDir, `${new_name}.ino`)
        );
      } catch { /* ino rename optional */ }
      return { content: [{ type: "text", text: `✅ "${old_name}" → "${new_name}" olarak yeniden adlandırıldı.` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Hata: ${(e as Error).message}` }] };
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
// COMPILE & UPLOAD TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "compile_sketch",
  "Sketch'i derler. FQBN belirtilmezse kayıtlı kart ayarlarını kullanır. Derleme hatalarını satır:sütun formatında gösterir.",
  {
    name: z.string().describe("Sketch adı"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel)"),
    verbose: z.boolean().default(false).describe("Detaylı çıktı"),
  },
  async ({ name, fqbn, verbose }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? buildFqbn(board) : null);
    if (!resolvedFqbn) {
      return { content: [{ type: "text", text: '❌ FQBN bulunamadı. Önce "detect_board" çalıştır.' }] };
    }
    const dir = path.join(SKETCHES_DIR, name);
    const verboseFlag = verbose ? " --verbose" : "";
    const r = await runCmd(`${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}"${verboseFlag} "${dir}" 2>&1`, 180000);
    return { content: [{ type: "text", text: formatCompileResult(r.ok, r.stdout, r.stderr, resolvedFqbn) }] };
  }
);

server.tool(
  "upload_sketch",
  "Derleme yapmadan sketch'i karta yükler. Port meşgulse otomatik serbest bırakır.",
  {
    name: z.string().describe("Sketch adı"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel)"),
    port: z.string().optional().describe("Upload portu (opsiyonel)"),
  },
  async ({ name, fqbn, port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? buildFqbn(board) : null);
    const resolvedPort = port || board?.uploadPort || null;
    if (!resolvedFqbn || !resolvedPort) {
      return { content: [{ type: "text", text: '❌ Port veya FQBN bulunamadı. Önce "detect_board" çalıştır.' }] };
    }
    await freePort(resolvedPort);
    await new Promise((r) => setTimeout(r, 500));
    await fixPortPermission(resolvedPort);
    const dir = path.join(SKETCHES_DIR, name);
    const r = await runCmd(`${ARDUINO_CLI} upload -p ${resolvedPort} --fqbn "${resolvedFqbn}" "${dir}" 2>&1`, 180000);
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{ type: "text", text: `${icon} Yükleme ${r.ok ? "başarılı" : "başarısız"} → ${resolvedPort}:\n${r.stdout}\n${r.stderr}`.trim() }],
    };
  }
);

server.tool(
  "compile_and_upload",
  "Sketch'i derler ve karta yükler (tek adım). Tüm kart türleri desteklenir. Kayıtlı kart ayarlarını kullanır.",
  {
    name: z.string().describe("Sketch adı"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel)"),
    port: z.string().optional().describe("Upload portu (opsiyonel)"),
  },
  async ({ name, fqbn, port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? buildFqbn(board) : null);
    const resolvedPort = port || board?.uploadPort || null;
    if (!resolvedFqbn || !resolvedPort) {
      return { content: [{ type: "text", text: '❌ Port veya FQBN bulunamadı. Önce "detect_board" çalıştır.' }] };
    }
    const dir = path.join(SKETCHES_DIR, name);
    const compile = await runCmd(`${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}" "${dir}" 2>&1`, 180000);
    if (!compile.ok) {
      return { content: [{ type: "text", text: formatCompileResult(false, compile.stdout, compile.stderr, resolvedFqbn) }] };
    }
    await freePort(resolvedPort);
    await new Promise((r) => setTimeout(r, 500));
    await fixPortPermission(resolvedPort);
    const upload = await runCmd(`${ARDUINO_CLI} upload -p ${resolvedPort} --fqbn "${resolvedFqbn}" "${dir}" 2>&1`, 180000);
    return {
      content: [{
        type: "text",
        text: [
          formatCompileResult(true, compile.stdout, compile.stderr, resolvedFqbn),
          `${upload.ok ? "✅" : "❌"} Yükleme ${upload.ok ? "başarılı" : "başarısız"} → ${resolvedPort}`,
          upload.ok ? "" : upload.stderr,
        ].filter(Boolean).join("\n"),
      }],
    };
  }
);

server.tool(
  "wifi_upload",
  "Sketch'i WiFi/OTA üzerinden karta yükler. Kart ArduinoOTA kütüphanesi ile hazırlanmış olmalı.",
  {
    name: z.string().describe("Sketch adı"),
    ip: z.string().describe("Kartın IP adresi"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel)"),
    password: z.string().optional().describe("OTA şifresi (opsiyonel)"),
  },
  async ({ name, ip, fqbn, password }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? buildFqbn(board) : null);
    if (!resolvedFqbn) {
      return { content: [{ type: "text", text: '❌ FQBN bulunamadı.' }] };
    }
    const dir = path.join(SKETCHES_DIR, name);
    const compile = await runCmd(`${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}" "${dir}" 2>&1`, 180000);
    if (!compile.ok) {
      return { content: [{ type: "text", text: formatCompileResult(false, compile.stdout, compile.stderr, resolvedFqbn) }] };
    }
    const passFlag = password ? `--upload-field password=${password}` : "";
    const r = await runCmd(`${ARDUINO_CLI} upload -p ${ip}:3232 --fqbn "${resolvedFqbn}" ${passFlag} "${dir}" 2>&1`, 120000);
    return {
      content: [{
        type: "text",
        text: [
          "✅ Derleme başarılı",
          `${r.ok ? "✅" : "❌"} OTA Yükleme ${r.ok ? "başarılı" : "başarısız"} → ${ip}`,
          r.stdout, r.stderr,
        ].filter(Boolean).join("\n"),
      }],
    };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// SERIAL TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "serial_monitor",
  "Serial port'tan veri okur. Port belirtilmezse kayıtlı monitor portunu kullanır.",
  {
    port: z.string().optional().describe("Seri port (opsiyonel)"),
    baud: z.number().default(115200).describe("Baud rate"),
    seconds: z.number().default(5).describe("Kaç saniye okusun (max 60)"),
  },
  async ({ port, baud, seconds }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";
    await fixPortPermission(resolvedPort);
    const clampedSeconds = Math.min(seconds, 60);
    return new Promise((resolve) => {
      let output = "";
      exec(`stty -F ${resolvedPort} ${baud} raw -echo 2>/dev/null`);
      const proc = spawn("timeout", [String(clampedSeconds), "cat", resolvedPort]);
      proc.stdout.on("data", (d: Buffer) => { output += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });
      proc.on("close", () => {
        const clean = output.split("\n")
          .map((l) => l.replace(/[^\x20-\x7E]/g, "").trim())
          .filter(Boolean).join("\n");
        resolve({
          content: [{
            type: "text",
            text: clean
              ? `📡 ${resolvedPort} @ ${baud} (${clampedSeconds}s):\n${clean}`
              : `📡 ${resolvedPort}: ${clampedSeconds}s içinde veri alınamadı.`,
          }],
        });
      });
    });
  }
);

server.tool(
  "send_serial",
  "Serial port üzerinden karta veri/komut gönderir ve yanıtı okur",
  {
    message: z.string().describe("Gönderilecek mesaj/komut"),
    port: z.string().optional().describe("Seri port (opsiyonel)"),
    baud: z.number().default(115200).describe("Baud rate"),
    newline: z.boolean().default(true).describe("Satır sonu ekle (\\n)"),
    read_response: z.boolean().default(true).describe("Yanıt oku (2s)"),
  },
  async ({ message, port, baud, newline, read_response }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";
    await fixPortPermission(resolvedPort);

    return new Promise((resolve) => {
      exec(`stty -F ${resolvedPort} ${baud} raw -echo 2>/dev/null`, () => {
        const data = newline ? `${message}\n` : message;
        try {
          const fd = fss.openSync(resolvedPort, "r+");
          fss.writeSync(fd, data);
          if (read_response) {
            let response = "";
            const proc = spawn("timeout", ["2", "cat", resolvedPort]);
            proc.stdout.on("data", (d: Buffer) => { response += d.toString(); });
            proc.on("close", () => {
              fss.closeSync(fd);
              const clean = response.split("\n")
                .map((l: string) => l.replace(/[^\x20-\x7E]/g, "").trim())
                .filter(Boolean).join("\n");
              resolve({
                content: [{
                  type: "text",
                  text: `📤 Gönderildi: "${message}"\n📥 Yanıt:\n${clean || "(yanıt yok)"}`,
                }],
              });
            });
          } else {
            fss.closeSync(fd);
            resolve({ content: [{ type: "text", text: `📤 Gönderildi: "${message}"` }] });
          }
        } catch (e: unknown) {
          resolve({ content: [{ type: "text", text: `❌ Gönderme hatası: ${(e as Error).message}` }] });
        }
      });
    });
  }
);

server.tool(
  "get_serial_ports",
  "Sistemdeki tüm seri portları vendor, model, seri no ve rolleriyle listeler",
  {},
  async () => {
    const ports = await detectPorts();
    if (ports.length === 0) return { content: [{ type: "text", text: "Bağlı seri port yok." }] };
    const lines = ports.map((p) => [
      `Port:    ${p.port}`,
      `Rol:     ${p.role === "upload" ? "📤 upload only" : p.role === "monitor" ? "📡 monitor only" : "📤📡 upload + monitor"}`,
      `Cihaz:   ${p.modelName || "Bilinmiyor"}`,
      `Vendor:  ${p.vendor}:${p.product}`,
      `Seri No: ${p.serial || "Bilinmiyor"}`,
      "─".repeat(44),
    ].join("\n"));
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// LIBRARY & PLATFORM TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "install_library",
  "Arduino kütüphanesi kurar. Versiyon belirtebilirsin.",
  {
    library: z.string().describe("Kütüphane adı"),
    version: z.string().optional().describe("Versiyon (ör: 1.4.0)"),
  },
  async ({ library, version }) => {
    const libStr = version ? `"${library}@${version}"` : `"${library}"`;
    const r = await runCmd(`${ARDUINO_CLI} lib install ${libStr} 2>&1`, 60000);
    const icon = r.ok ? "✅" : "❌";
    return { content: [{ type: "text", text: `${icon} "${library}" ${r.ok ? "kuruldu" : "kurulamadı"}:\n${r.stdout}\n${r.stderr}`.trim() }] };
  }
);

server.tool(
  "uninstall_library",
  "Arduino kütüphanesini kaldırır",
  { library: z.string().describe("Kütüphane adı") },
  async ({ library }) => {
    const r = await runCmd(`${ARDUINO_CLI} lib uninstall "${library}" 2>&1`, 30000);
    const icon = r.ok ? "✅" : "❌";
    return { content: [{ type: "text", text: `${icon} "${library}" ${r.ok ? "kaldırıldı" : "kaldırılamadı"}:\n${r.stdout}\n${r.stderr}`.trim() }] };
  }
);

server.tool(
  "list_libraries",
  "Kurulu Arduino kütüphanelerini listeler",
  { filter: z.string().optional().describe("Filtreleme (opsiyonel)") },
  async ({ filter }) => {
    const r = await runCmd(`${ARDUINO_CLI} lib list 2>&1`, 30000);
    if (!r.ok) return { content: [{ type: "text", text: `Hata: ${r.stderr}` }] };
    let output = r.stdout;
    if (filter) {
      output = output.split("\n").filter((l) => l.toLowerCase().includes(filter.toLowerCase())).join("\n");
    }
    return { content: [{ type: "text", text: output || "Kurulu kütüphane yok." }] };
  }
);

server.tool(
  "search_library",
  "Arduino kütüphane deposunda arama yapar",
  { query: z.string().describe("Arama terimi") },
  async ({ query }) => {
    const r = await runCmd(`${ARDUINO_CLI} lib search "${query}" 2>&1`, 30000);
    if (!r.ok) return { content: [{ type: "text", text: `Hata: ${r.stderr}` }] };
    return { content: [{ type: "text", text: r.stdout.split("\n").slice(0, 50).join("\n") || "Sonuç bulunamadı." }] };
  }
);

server.tool(
  "update_libraries",
  "Tüm kurulu kütüphaneleri günceller",
  {},
  async () => {
    const r = await runCmd(`${ARDUINO_CLI} lib upgrade 2>&1`, 120000);
    const icon = r.ok ? "✅" : "❌";
    return { content: [{ type: "text", text: `${icon} Kütüphane güncellemesi ${r.ok ? "tamamlandı" : "başarısız"}:\n${r.stdout}\n${r.stderr}`.trim() }] };
  }
);

server.tool(
  "install_board",
  "Kart platform paketini kurar. ESP32, AVR, SAMD, RP2040 vb. desteklenir.",
  { platform: z.string().describe("Platform (ör: esp32:esp32, arduino:avr, rp2040:rp2040)") },
  async ({ platform }) => {
    const extraUrls: Record<string, string> = {
      "esp32:esp32": "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json",
      "rp2040:rp2040": "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json",
      "esp8266:esp8266": "https://arduino.esp8266.com/stable/package_esp8266com_index.json",
    };
    const prefix = platform.split(":").slice(0, 2).join(":");
    if (extraUrls[prefix]) {
      await runCmd(`${ARDUINO_CLI} config add board_manager.additional_urls "${extraUrls[prefix]}" 2>&1`);
      await runCmd(`${ARDUINO_CLI} core update-index 2>&1`, 30000);
    }
    const r = await runCmd(`${ARDUINO_CLI} core install ${platform} 2>&1`, 300000);
    const icon = r.ok ? "✅" : "❌";
    return { content: [{ type: "text", text: `${icon} ${platform} ${r.ok ? "kuruldu" : "kurulamadı"}:\n${r.stdout}\n${r.stderr}`.trim() }] };
  }
);

server.tool(
  "update_boards",
  "Tüm kurulu kart platformlarını günceller",
  {},
  async () => {
    await runCmd(`${ARDUINO_CLI} core update-index 2>&1`, 30000);
    const r = await runCmd(`${ARDUINO_CLI} core upgrade 2>&1`, 300000);
    const icon = r.ok ? "✅" : "❌";
    return { content: [{ type: "text", text: `${icon} Kart güncellemesi ${r.ok ? "tamamlandı" : "başarısız"}:\n${r.stdout}\n${r.stderr}`.trim() }] };
  }
);

server.tool(
  "list_installed_boards",
  "Kurulu kart platformlarını listeler",
  {},
  async () => {
    const r = await runCmd(`${ARDUINO_CLI} core list 2>&1`, 30000);
    return { content: [{ type: "text", text: r.stdout || "Kurulu platform yok." }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// IDE & CLI TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "open_arduino_ide",
  "Arduino IDE 2'yi açar. Sketch adı belirtilirse o sketch ile açar.",
  { sketch: z.string().optional().describe("Açılacak sketch adı (opsiyonel)") },
  async ({ sketch }) => {
    const idePath = process.env.ARDUINO_IDE_PATH ||
      path.join(os.homedir(), "Applications", "arduino-ide_2.3.10_Linux_64bit.AppImage");
    let cmd = `"${idePath}" --no-sandbox`;
    if (sketch) {
      const file = path.join(SKETCHES_DIR, sketch, `${sketch}.ino`);
      cmd += ` "${file}"`;
    }
    cmd += " &>/dev/null &";
    await runCmd(cmd, 5000);
    return { content: [{ type: "text", text: sketch ? `✅ Arduino IDE açılıyor: ${sketch}` : `✅ Arduino IDE açılıyor...` }] };
  }
);

server.tool(
  "arduino_cli_check",
  "Arduino CLI kurulu mu kontrol eder",
  {},
  async () => {
    const r = await runCmd(`${ARDUINO_CLI} version`);
    if (r.ok) return { content: [{ type: "text", text: `✅ Arduino CLI kurulu:\n${r.stdout}` }] };
    return {
      content: [{
        type: "text",
        text: "❌ Arduino CLI bulunamadı.\nKurulum:\n  curl -fsSL https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_64bit.tar.gz -o /tmp/cli.tar.gz\n  tar -xzf /tmp/cli.tar.gz -C /tmp/\n  sudo mv /tmp/arduino-cli /usr/local/bin/",
      }],
    };
  }
);

server.tool(
  "arduino_cli_config",
  "Arduino CLI yapılandırmasını gösterir veya board manager URL ekler/kaldırır",
  {
    action: z.enum(["show", "add_url", "reset"]).default("show"),
    url: z.string().optional().describe("Board manager URL (add_url için)"),
  },
  async ({ action, url }) => {
    if (action === "show") {
      const r = await runCmd(`${ARDUINO_CLI} config dump 2>&1`);
      return { content: [{ type: "text", text: r.stdout || r.stderr }] };
    }
    if (action === "add_url" && url) {
      const r = await runCmd(`${ARDUINO_CLI} config add board_manager.additional_urls "${url}" 2>&1`);
      return { content: [{ type: "text", text: `${r.ok ? "✅" : "❌"} URL eklendi: ${url}\n${r.stdout}` }] };
    }
    if (action === "reset") {
      const r = await runCmd(`${ARDUINO_CLI} config init --overwrite 2>&1`);
      return { content: [{ type: "text", text: `✅ Config sıfırlandı.\n${r.stdout}` }] };
    }
    return { content: [{ type: "text", text: "❌ Geçersiz işlem." }] };
  }
);



// ════════════════════════════════════════════════════════════════════════════
// PROJECT TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "project_init",
  "Bir sketch için arduino-mcp.yaml proje dosyası oluşturur. FQBN, port, kütüphaneler ve build flag'leri kaydeder.",
  {
    name: z.string().describe("Sketch adı"),
    description: z.string().optional().describe("Proje açıklaması"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel, kayıtlı kart kullanılır)"),
    libraries: z.array(z.string()).optional().describe("Gerekli kütüphaneler (ör: [DHT sensor library, FastLED])"),
    baud: z.number().optional().describe("Serial baud rate"),
  },
  async ({ name, description, fqbn, libraries, baud }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;

    const project: ArduinoProject = {
      name,
      description: description || `Arduino project: ${name}`,
      version: "1.0.0",
      fqbn: fqbn || (board ? buildFqbn(board) : undefined),
      upload_port: board?.uploadPort,
      monitor_port: board?.monitorPort,
      baud: baud || 115200,
      libraries: libraries || [],
    };

    await writeProjectConfig(name, project);
    return {
      content: [{
        type: "text",
        text: [
          `✅ Proje dosyası oluşturuldu: ~/Arduino/${name}/arduino-mcp.yaml`,
          `FQBN:     ${project.fqbn || "belirtilmedi"}`,
          `Upload:   ${project.upload_port || "belirtilmedi"}`,
          `Monitor:  ${project.monitor_port || "belirtilmedi"}`,
          `Baud:     ${project.baud}`,
          project.libraries?.length ? `Libs:     ${project.libraries.join(", ")}` : "",
        ].filter(Boolean).join("\n"),
      }],
    };
  }
);

server.tool(
  "project_info",
  "Bir sketch'in arduino-mcp.yaml proje dosyasını gösterir",
  { name: z.string().describe("Sketch adı") },
  async ({ name }) => {
    const project = await readProjectConfig(name);
    if (!project) {
      return {
        content: [{
          type: "text",
          text: `❌ ~/Arduino/${name}/arduino-mcp.yaml bulunamadı. "project_init" ile oluştur.`,
        }],
      };
    }
    const files = await listProjectFiles(name);
    return {
      content: [{
        type: "text",
        text: [
          `📦 Proje: ${project.name}`,
          project.description ? `Açıklama: ${project.description}` : "",
          project.version ? `Versiyon: ${project.version}` : "",
          `FQBN:     ${project.fqbn || "belirtilmedi"}`,
          `Upload:   ${project.upload_port || "belirtilmedi"}`,
          `Monitor:  ${project.monitor_port || "belirtilmedi"}`,
          `Baud:     ${project.baud || 115200}`,
          project.libraries?.length ? `Libs:     ${project.libraries.join(", ")}` : "",
          `Dosyalar: ${files.join(", ")}`,
        ].filter(Boolean).join("\n"),
      }],
    };
  }
);

server.tool(
  "project_list_files",
  "Bir sketch klasöründeki tüm kaynak dosyaları listeler (.ino, .h, .cpp, .c)",
  { name: z.string().describe("Sketch adı") },
  async ({ name }) => {
    const files = await listProjectFiles(name);
    if (files.length === 0) {
      return { content: [{ type: "text", text: `❌ ~/Arduino/${name} bulunamadı veya boş.` }] };
    }
    return {
      content: [{ type: "text", text: `📂 ~/Arduino/${name}/\n${files.map((f) => `  • ${f}`).join("\n")}` }],
    };
  }
);

server.tool(
  "project_read_file",
  "Bir sketch klasöründeki belirli bir dosyayı okur (.ino, .h, .cpp vb.)",
  {
    name: z.string().describe("Sketch adı"),
    filename: z.string().describe("Dosya adı (ör: main.ino, sensors.h)"),
  },
  async ({ name, filename }) => {
    const content2 = await readProjectFile(name, filename);
    if (content2 === null) {
      return { content: [{ type: "text", text: `❌ ~/Arduino/${name}/${filename} bulunamadı.` }] };
    }
    const ext = filename.split(".").pop() || "cpp";
    return {
      content: [{ type: "text", text: `📄 ${filename}:\n\`\`\`${ext}\n${content2}\n\`\`\`` }],
    };
  }
);

server.tool(
  "project_write_file",
  "Bir sketch klasörüne yeni bir dosya yazar veya günceller (.h, .cpp, .c header/kaynak dosyaları)",
  {
    name: z.string().describe("Sketch adı"),
    filename: z.string().describe("Dosya adı (ör: sensors.h, utils.cpp)"),
    content: z.string().describe("Dosya içeriği"),
  },
  async ({ name, filename, content: fileContent }) => {
    await writeProjectFile(name, filename, fileContent);
    return {
      content: [{ type: "text", text: `✅ ~/Arduino/${name}/${filename} yazıldı.` }],
    };
  }
);

server.tool(
  "project_install_deps",
  "Proje arduino-mcp.yaml dosyasındaki tüm kütüphaneleri kurar",
  { name: z.string().describe("Sketch adı") },
  async ({ name }) => {
    const project = await readProjectConfig(name);
    if (!project) {
      return { content: [{ type: "text", text: `❌ ~/Arduino/${name}/arduino-mcp.yaml bulunamadı.` }] };
    }
    if (!project.libraries || project.libraries.length === 0) {
      return { content: [{ type: "text", text: "ℹ️ Bu projede tanımlı kütüphane yok." }] };
    }

    const results: string[] = [];
    for (const lib of project.libraries) {
      const r = await runCmd(`${ARDUINO_CLI} lib install "${lib}" 2>&1`, 60000);
      results.push(`${r.ok ? "✅" : "❌"} ${lib}: ${r.ok ? "kuruldu" : r.stderr.split("\n")[0]}`);
    }
    return { content: [{ type: "text", text: results.join("\n") }] };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// PERSISTENT SERIAL BUFFER TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "serial_start",
  "Serial portu arka planda sürekli dinlemeye başlar. Kart çalışırken tüm çıktıları buffer'da biriktirir. serial_read ile istediğinde okursun.",
  {
    port: z.string().optional().describe("Port (opsiyonel, kayıtlı monitor portu)"),
    baud: z.number().default(115200).describe("Baud rate"),
  },
  async ({ port, baud }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";
    await fixPortPermission(resolvedPort);
    const result = serialBuffer.start(resolvedPort, baud);
    const icon = result.ok ? "✅" : "❌";
    return { content: [{ type: "text", text: `${icon} ${result.message}` }] };
  }
);

server.tool(
  "serial_read",
  "Arka planda çalışan serial buffer'dan son N satırı okur. serial_start ile başlatılmış olmalı.",
  {
    port: z.string().optional().describe("Port (opsiyonel)"),
    lines: z.number().default(50).describe("Kaç satır okunacak (max 500)"),
    clear: z.boolean().default(false).describe("Okuduktan sonra buffer'ı temizle"),
  },
  async ({ port, lines, clear }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";
    const result = serialBuffer.read(resolvedPort, Math.min(lines, 500), clear);
    if (!result.ok) {
      return { content: [{ type: "text", text: `❌ ${result.message}` }] };
    }
    if (result.lines.length === 0) {
      return { content: [{ type: "text", text: `📡 ${resolvedPort}: Buffer boş (henüz veri yok)` }] };
    }
    return {
      content: [{
        type: "text",
        text: `📡 ${resolvedPort} — son ${result.lines.length} satır:
${result.lines.join("\n")}`,
      }],
    };
  }
);

server.tool(
  "serial_stop",
  "Arka planda çalışan serial buffer'ı durdurur",
  {
    port: z.string().optional().describe("Port (opsiyonel, tümü için boş bırak)"),
  },
  async ({ port }) => {
    if (!port) {
      serialBuffer.stopAll();
      return { content: [{ type: "text", text: "✅ Tüm serial buffer oturumları durduruldu." }] };
    }
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";
    const result = serialBuffer.stop(resolvedPort);
    const icon = result.ok ? "✅" : "❌";
    return { content: [{ type: "text", text: `${icon} ${result.message}` }] };
  }
);

server.tool(
  "serial_status",
  "Aktif serial buffer oturumlarını listeler (port, baud, satır sayısı, çalışma süresi)",
  {},
  async () => {
    const sessions = serialBuffer.status();
    if (sessions.length === 0) {
      return { content: [{ type: "text", text: "📡 Aktif serial buffer oturumu yok." }] };
    }
    const lines = sessions.map((s) =>
      `${s.port}  @ ${s.baud} baud  |  ${s.lineCount} satır  |  ${s.byteCount} byte  |  uptime: ${s.uptime}`
    );
    return { content: [{ type: "text", text: `📡 Aktif oturumlar:\n${lines.join("\n")}` }] };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 arduino-mcp v3.3.0 started");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
