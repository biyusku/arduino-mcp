#!/usr/bin/env node
/**
 * arduino-mcp v3.0.0
 * MCP server for Arduino IDE & arduino-cli
 * https://github.com/birusk/arduino-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as net from "net";

const execAsync = promisify(exec);

// ─── Constants ───────────────────────────────────────────────────────────────

const ARDUINO_CLI = process.env.ARDUINO_CLI_PATH || "arduino-cli";
const SKETCHES_DIR = process.env.ARDUINO_SKETCHES_DIR || path.join(os.homedir(), "Arduino");
const CONFIG_FILE = path.join(os.homedir(), ".arduino-mcp.json");

// UART bridge chips (upload-only)
const UPLOAD_VENDORS = new Set(["1a86", "10c4", "0403", "2341", "1a86"]);
// ESP32-S3/S2 native USB (monitor only by default)
const NATIVE_USB_VENDOR = "303a";

// ─── Types ───────────────────────────────────────────────────────────────────

interface BoardConfig {
  fqbn: string;
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

function buildFqbn(board: BoardConfig): string {
  const opts: string[] = [];
  if (board.cdcOnBoot) opts.push(`CDCOnBoot=${board.cdcOnBoot}`);
  if (board.flashSize) opts.push(`FlashSize=${board.flashSize}`);
  if (board.psram) opts.push(`PSRAM=${board.psram}`);
  if (board.partitionScheme) opts.push(`PartitionScheme=${board.partitionScheme}`);
  if (board.uploadSpeed) opts.push(`UploadSpeed=${board.uploadSpeed}`);
  return opts.length > 0 ? `${board.fqbn}:${opts.join(",")}` : board.fqbn;
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
  // Match: /path/file.ino:LINE:COL: error: MESSAGE
  const re = /^(.+?):(\d+):(\d+):\s+error:\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    errors.push({
      file: path.basename(m[1]),
      line: parseInt(m[2]),
      col: parseInt(m[3]),
      message: m[4].trim(),
    });
  }
  return errors;
}

function formatCompileErrors(errors: CompileError[]): string {
  if (errors.length === 0) return "";
  return (
    "\n\n🔴 Derleme Hataları:\n" +
    errors
      .map((e) => `  ${e.file}:${e.line}:${e.col} — ${e.message}`)
      .join("\n")
  );
}

// ─── Auto-detect ─────────────────────────────────────────────────────────────

interface DetectedPort {
  port: string;
  vendor: string;
  product: string;
  serial: string;
  modelName: string;
  role: "upload" | "monitor" | "both";
}

async function detectPorts(): Promise<DetectedPort[]> {
  const devList = await runCmd("ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null");
  if (!devList.stdout) return [];

  const ports: DetectedPort[] = [];
  for (const port of devList.stdout.split("\n").filter(Boolean)) {
    const udev = await runCmd(`udevadm info --query=all --name=${port} 2>/dev/null`);
    if (!udev.ok) continue;

    const vendor = udev.stdout.match(/ID_VENDOR_ID=([0-9a-f]+)/i)?.[1]?.toLowerCase() || "";
    const product = udev.stdout.match(/ID_MODEL_ID=([0-9a-f]+)/i)?.[1]?.toLowerCase() || "";
    const serial = udev.stdout.match(/ID_SERIAL_SHORT=([^\n]+)/)?.[1]?.trim() || "";
    const modelName = udev.stdout.match(/ID_MODEL=([^\n]+)/)?.[1]?.trim() || "";

    if (!vendor) continue;

    let role: DetectedPort["role"] = "both";
    if (UPLOAD_VENDORS.has(vendor)) role = "upload";
    else if (vendor === NATIVE_USB_VENDOR) role = "monitor";

    ports.push({ port, vendor, product, serial, modelName, role });
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

  const uploadPort = ports.find((p) => p.role === "upload" || p.role === "both");
  const monitorPort = ports.find((p) => p.role === "monitor" || p.role === "both");

  const up = uploadPort || monitorPort;
  const mp = monitorPort || uploadPort;
  if (!up || !mp) return null;

  const boardList = await runCmd(`${ARDUINO_CLI} board list 2>/dev/null`);
  let fqbn: string | undefined;
  let boardName: string | undefined;

  if (boardList.ok) {
    for (const line of boardList.stdout.split("\n")) {
      if (line.includes(up.port) || line.includes(mp.port)) {
        const match = line.match(/(esp32:\S+|arduino:\S+)/);
        if (match) fqbn = match[0];
        const parts = line.trim().split(/\s{2,}/);
        if (parts.length >= 3) boardName = parts[2];
      }
    }
  }

  return {
    uploadPort: up.port,
    monitorPort: mp.port,
    serial: up.serial || mp.serial,
    fqbn,
    boardName,
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "arduino-mcp",
  version: "3.0.0",
});

// ════════════════════════════════════════════════════════════════════════════
// BOARD TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "detect_board",
  "Bağlı Arduino/ESP32 kartını otomatik tanır. Upload ve monitor portlarını ayrı ayrı tespit eder (ESP32-S3 dual-USB dahil). Kart bilgilerini hafızaya kaydeder.",
  { save: z.boolean().default(true).describe("Kartı hafızaya kaydet") },
  async ({ save }) => {
    const detected = await autoDetect();
    if (!detected) {
      return {
        content: [{ type: "text", text: "❌ Bağlı kart bulunamadı. USB kablosunu kontrol et." }],
      };
    }

    let savedMsg = "";
    if (save) {
      const serial = detected.serial || `unknown_${Date.now()}`;
      const cfg = await loadConfig();
      const baseFqbn = detected.fqbn?.split(":").slice(0, 3).join(":") || "esp32:esp32:esp32s3";
      const isS3 = baseFqbn.includes("s3");

      cfg.boards[serial] = {
        fqbn: baseFqbn,
        uploadPort: detected.uploadPort,
        monitorPort: detected.monitorPort,
        cdcOnBoot: "default",
        flashSize: "16M",
        psram: isS3 ? "opi" : undefined,
        boardName: detected.boardName,
        lastSeen: new Date().toISOString(),
      };
      cfg.defaultBoard = serial;
      await saveConfig(cfg);
      savedMsg = "\n✅ Kart hafızaya kaydedildi.";
    }

    return {
      content: [{
        type: "text",
        text: [
          "🔍 Kart Tespit Edildi",
          `Kart:          ${detected.boardName || "Bilinmiyor"}`,
          `FQBN:          ${detected.fqbn || "Tespit edilemedi"}`,
          `Upload Port:   ${detected.uploadPort}`,
          `Monitor Port:  ${detected.monitorPort}`,
          `Seri No:       ${detected.serial || "Bilinmiyor"}`,
          savedMsg,
        ].filter(Boolean).join("\n"),
      }],
    };
  }
);

server.tool(
  "board_config",
  "Kayıtlı kart ayarlarını göster veya güncelle. Tüm FQBN seçenekleri (flash, psram, cdc, partition, upload speed) ayarlanabilir.",
  {
    action: z.enum(["show", "set"]).default("show").describe("show: göster, set: güncelle"),
    fqbn: z.string().optional().describe("Kart FQBN (ör: esp32:esp32:esp32s3)"),
    upload_port: z.string().optional().describe("Upload portu (ör: /dev/ttyACM1)"),
    monitor_port: z.string().optional().describe("Monitor portu (ör: /dev/ttyACM0)"),
    flash_size: z.string().optional().describe("Flash boyutu: 2M | 4M | 8M | 16M"),
    psram: z.string().optional().describe("PSRAM: opi | qspi | disabled"),
    cdc_on_boot: z.string().optional().describe("CDCOnBoot: default | cdc | disabled"),
    partition_scheme: z.string().optional().describe("Partition: default | huge_app | min_spiffs | no_ota"),
    upload_speed: z.string().optional().describe("Upload hızı: 921600 | 460800 | 230400 | 115200"),
  },
  async ({ action, fqbn, upload_port, monitor_port, flash_size, psram, cdc_on_boot, partition_scheme, upload_speed }) => {
    const cfg = await loadConfig();

    if (action === "show") {
      if (!cfg.defaultBoard || !cfg.boards[cfg.defaultBoard]) {
        return { content: [{ type: "text", text: '❌ Kayıtlı kart yok. Önce "detect_board" çalıştır.' }] };
      }
      const b = cfg.boards[cfg.defaultBoard];
      return {
        content: [{
          type: "text",
          text: [
            "📋 Kayıtlı Kart Ayarları",
            `Seri No:        ${cfg.defaultBoard}`,
            `Kart:           ${b.boardName || "Bilinmiyor"}`,
            `FQBN:           ${buildFqbn(b)}`,
            `Upload Port:    ${b.uploadPort}`,
            `Monitor Port:   ${b.monitorPort}`,
            `Flash:          ${b.flashSize || "varsayılan"}`,
            `PSRAM:          ${b.psram || "varsayılan"}`,
            `CDC on Boot:    ${b.cdcOnBoot || "varsayılan"}`,
            `Partition:      ${b.partitionScheme || "varsayılan"}`,
            `Upload Speed:   ${b.uploadSpeed || "921600"}`,
            `Son Görülme:    ${b.lastSeen}`,
          ].join("\n"),
        }],
      };
    }

    if (!cfg.defaultBoard) {
      return { content: [{ type: "text", text: '❌ Önce "detect_board" çalıştır.' }] };
    }

    const b = cfg.boards[cfg.defaultBoard];
    if (fqbn) b.fqbn = fqbn.split(":").slice(0, 3).join(":");
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
  "Bir kart için mevcut tüm FQBN seçeneklerini listeler (flash boyutu, psram, cdc, partition vb.)",
  {
    fqbn: z.string().optional().describe("Kart FQBN (belirtilmezse kayıtlı kart)"),
  },
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
  "Bağlı tüm Arduino/ESP32 kartlarını, portlarını ve rollerini listeler (upload/monitor ayrımıyla)",
  {},
  async () => {
    const ports = await detectPorts();
    const cliList = await runCmd(`${ARDUINO_CLI} board list 2>&1`);

    const lines: string[] = ["🔌 Bağlı Portlar:\n"];

    if (ports.length === 0) {
      lines.push("  Bağlı cihaz yok.");
    } else {
      for (const p of ports) {
        lines.push(`  ${p.port}  [${p.role}]  ${p.modelName || p.vendor + ":" + p.product}  SN:${p.serial || "?"}`);
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
  "Bağlı kartın detaylı bilgisini gösterir (chip, flash, PSRAM, MAC, revision)",
  {
    port: z.string().optional().describe("Port (opsiyonel, varsayılan kayıtlı upload port)"),
  },
  async ({ port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.uploadPort || "/dev/ttyACM0";

    await fixPortPermission(resolvedPort);

    const r = await runCmd(`${ARDUINO_CLI} board info --port ${resolvedPort} 2>&1`);
    if (r.ok && r.stdout) return { content: [{ type: "text", text: r.stdout }] };

    // Fallback: udevadm
    const udev = await runCmd(
      `udevadm info --query=all --name=${resolvedPort} 2>&1 | grep -E "ID_VENDOR|ID_MODEL|ID_SERIAL|ID_USB"`
    );
    const lsusb = await runCmd("lsusb 2>/dev/null | grep -iE '303a|1a86|2341|10c4|0403'");
    return {
      content: [{
        type: "text",
        text: [udev.stdout, lsusb.stdout].filter(Boolean).join("\n") || "Kart bilgisi alınamadı.",
      }],
    };
  }
);

server.tool(
  "erase_flash",
  "ESP32/ESP8266 kartının tüm flash belleğini siler. Dikkat: tüm veriler silinir!",
  {
    port: z.string().optional().describe("Port (opsiyonel)"),
  },
  async ({ port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.uploadPort || "/dev/ttyACM0";

    await freePort(resolvedPort);
    await fixPortPermission(resolvedPort);

    const r = await runCmd(
      `esptool.py --port ${resolvedPort} erase_flash 2>&1`,
      60000
    );
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
  "~/Arduino klasöründeki tüm sketch'leri listeler (son değiştirilme tarihleriyle)",
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
            return `  • ${d.name.padEnd(30)} ${stat.mtime.toLocaleDateString("tr-TR")}`;
          } catch {
            return `  • ${d.name}`;
          }
        })
      );

      return {
        content: [{
          type: "text",
          text: `Sketch'ler (${SKETCHES_DIR}):\n${lines.join("\n")}`,
        }],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Hata: ${(e as Error).message}` }] };
    }
  }
);

server.tool(
  "create_sketch",
  "Yeni Arduino sketch'i oluşturur. Şablon olarak blink, wifi, mqtt, sensor seçilebilir.",
  {
    name: z.string().describe("Sketch adı"),
    template: z.enum(["blink", "wifi", "mqtt", "sensor", "empty", "custom"]).default("blink").describe("Başlangıç şablonu"),
    code: z.string().optional().describe("Özel kod (template=custom ise kullanılır)"),
  },
  async ({ name, template, code }) => {
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
    const dir = await ensureSketchDir(safeName);
    const file = path.join(dir, `${safeName}.ino`);

    const templates: Record<string, string> = {
      empty: `// ${safeName}\n\nvoid setup() {\n}\n\nvoid loop() {\n}\n`,
      blink: `// ${safeName} — Blink
#define LED_PIN 2

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("${safeName} started!");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);
  delay(500);
  digitalWrite(LED_PIN, LOW);
  delay(500);
}
`,
      wifi: `// ${safeName} — WiFi Connect
#include <WiFi.h>

const char* ssid = "YOUR_SSID";
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
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  delay(1000);
}
`,
      mqtt: `// ${safeName} — MQTT
#include <WiFi.h>
#include <PubSubClient.h>

const char* ssid = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";
const char* mqtt_server = "broker.hivemq.com";

WiFiClient espClient;
PubSubClient client(espClient);

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message [");
  Serial.print(topic);
  Serial.print("]: ");
  for (unsigned int i = 0; i < length; i++) Serial.print((char)payload[i]);
  Serial.println();
}

void reconnect() {
  while (!client.connected()) {
    if (client.connect("ESP32Client")) {
      client.subscribe("test/topic");
    } else {
      delay(5000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  client.setServer(mqtt_server, 1883);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();
  client.publish("test/topic", "Hello from ESP32!");
  delay(5000);
}
`,
      sensor: `// ${safeName} — Sensor Read
#define SENSOR_PIN 34  // Analog pin

void setup() {
  Serial.begin(115200);
  pinMode(SENSOR_PIN, INPUT);
  Serial.println("Sensor ready");
}

void loop() {
  int value = analogRead(SENSOR_PIN);
  float voltage = value * (3.3 / 4095.0);
  Serial.printf("Raw: %d  Voltage: %.2fV\\n", value, voltage);
  delay(1000);
}
`,
    };

    const finalCode = template === "custom" && code ? code : templates[template] || templates.blink;
    await fs.writeFile(file, finalCode, "utf-8");

    return {
      content: [{
        type: "text",
        text: `✅ Sketch oluşturuldu: ${file}\n\n\`\`\`cpp\n${finalCode}\n\`\`\``,
      }],
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
    const oldFile = path.join(newDir, `${old_name}.ino`);
    const newFile = path.join(newDir, `${new_name}.ino`);

    try {
      await fs.rename(oldDir, newDir);
      // .ino dosyasını da yeniden adlandır
      try {
        await fs.rename(oldFile, newFile);
      } catch {
        // farklı isimde olabilir, yoksay
      }
      return { content: [{ type: "text", text: `✅ "${old_name}" → "${new_name}" olarak yeniden adlandırıldı.` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `❌ Hata: ${(e as Error).message}` }] };
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════════
// COMPILE & UPLOAD TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "compile_sketch",
  "Sketch'i derler. FQBN belirtilmezse kayıtlı kart ayarlarını kullanır. Hataları satır:sütun formatında gösterir.",
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
    const r = await runCmd(
      `${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}"${verboseFlag} "${dir}" 2>&1`,
      180000
    );

    const errors = parseCompileErrors(r.stdout + "\n" + r.stderr);
    const errSummary = !r.ok ? formatCompileErrors(errors) : "";
    const icon = r.ok ? "✅" : "❌";

    return {
      content: [{
        type: "text",
        text: `${icon} Derleme ${r.ok ? "başarılı" : "başarısız"} (${resolvedFqbn}):\n${r.stdout}${errSummary}`.trim(),
      }],
    };
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
    const r = await runCmd(
      `${ARDUINO_CLI} upload -p ${resolvedPort} --fqbn "${resolvedFqbn}" "${dir}" 2>&1`,
      180000
    );
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{
        type: "text",
        text: `${icon} Yükleme ${r.ok ? "başarılı" : "başarısız"} → ${resolvedPort}:\n${r.stdout}\n${r.stderr}`.trim(),
      }],
    };
  }
);

server.tool(
  "compile_and_upload",
  "Sketch'i derler ve karta yükler (tek adım). En çok kullanılan araç — sadece sketch adını ver, gerisini halleder.",
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

    // Derle
    const compile = await runCmd(
      `${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}" "${dir}" 2>&1`,
      180000
    );
    if (!compile.ok) {
      const errors = parseCompileErrors(compile.stdout + "\n" + compile.stderr);
      return {
        content: [{
          type: "text",
          text: `❌ Derleme başarısız:\n${compile.stdout}${formatCompileErrors(errors)}`.trim(),
        }],
      };
    }

    // Port serbest bırak
    await freePort(resolvedPort);
    await new Promise((r) => setTimeout(r, 500));
    await fixPortPermission(resolvedPort);

    // Yükle
    const upload = await runCmd(
      `${ARDUINO_CLI} upload -p ${resolvedPort} --fqbn "${resolvedFqbn}" "${dir}" 2>&1`,
      180000
    );

    return {
      content: [{
        type: "text",
        text: [
          "✅ Derleme başarılı",
          `${upload.ok ? "✅" : "❌"} Yükleme ${upload.ok ? "başarılı" : "başarısız"} → ${resolvedPort}`,
          upload.stdout,
          upload.stderr,
        ].filter(Boolean).join("\n"),
      }],
    };
  }
);

server.tool(
  "wifi_upload",
  "Sketch'i WiFi üzerinden karta yükler (OTA - Over The Air). Kart WiFi'a bağlı ve ArduinoOTA kütüphanesi kurulu olmalı.",
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

    // Derle
    const compile = await runCmd(
      `${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}" "${dir}" 2>&1`,
      180000
    );
    if (!compile.ok) {
      return { content: [{ type: "text", text: `❌ Derleme başarısız:\n${compile.stdout}`.trim() }] };
    }

    // OTA yükle
    const passFlag = password ? `--upload-field password=${password}` : "";
    const r = await runCmd(
      `${ARDUINO_CLI} upload -p ${ip}:3232 --fqbn "${resolvedFqbn}" ${passFlag} "${dir}" 2>&1`,
      120000
    );
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{
        type: "text",
        text: `✅ Derleme başarılı\n${icon} OTA Yükleme ${r.ok ? "başarılı" : "başarısız"} → ${ip}:\n${r.stdout}\n${r.stderr}`.trim(),
      }],
    };
  }
);

// ════════════════════════════════════════════════════════════════════════════
// SERIAL TOOLS
// ════════════════════════════════════════════════════════════════════════════

server.tool(
  "serial_monitor",
  "Serial port'tan belirtilen süre boyunca veri okur. Port belirtilmezse kayıtlı monitor portunu kullanır.",
  {
    port: z.string().optional().describe("Seri port (opsiyonel)"),
    baud: z.number().default(115200).describe("Baud rate"),
    seconds: z.number().default(5).describe("Kaç saniye okusun (max 60)"),
  },
  async ({ port, baud, seconds }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";
    const clampedSeconds = Math.min(seconds, 60);

    await fixPortPermission(resolvedPort);

    return new Promise((resolve) => {
      let output = "";
      exec(`stty -F ${resolvedPort} ${baud} raw -echo 2>/dev/null`);
      const proc = spawn("timeout", [String(clampedSeconds), "cat", resolvedPort]);

      proc.stdout.on("data", (d: Buffer) => { output += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { output += d.toString(); });

      proc.on("close", () => {
        const clean = output
          .split("\n")
          .map((l) => l.replace(/[^\x20-\x7E]/g, "").trim())
          .filter(Boolean)
          .join("\n");

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
  "Serial port üzerinden karta veri/komut gönderir",
  {
    message: z.string().describe("Gönderilecek mesaj/komut"),
    port: z.string().optional().describe("Seri port (opsiyonel)"),
    baud: z.number().default(115200).describe("Baud rate"),
    newline: z.boolean().default(true).describe("Satır sonu ekle (\\n)"),
    read_response: z.boolean().default(true).describe("Gönderden sonra yanıt oku (2s)"),
  },
  async ({ message, port, baud, newline, read_response }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";

    await fixPortPermission(resolvedPort);

    return new Promise((resolve) => {
      exec(`stty -F ${resolvedPort} ${baud} raw -echo 2>/dev/null`, () => {
        const data = newline ? `${message}\n` : message;
        const fd = require("fs").openSync(resolvedPort, "r+");
        require("fs").writeSync(fd, data);

        if (read_response) {
          let response = "";
          const proc = spawn("timeout", ["2", "cat", resolvedPort]);
          proc.stdout.on("data", (d: Buffer) => { response += d.toString(); });
          proc.on("close", () => {
            require("fs").closeSync(fd);
            const clean = response.split("\n").map((l: string) => l.replace(/[^\x20-\x7E]/g, "").trim()).filter(Boolean).join("\n");
            resolve({
              content: [{
                type: "text",
                text: `📤 Gönderildi: "${message}"\n📥 Yanıt:\n${clean || "(yanıt yok)"}`,
              }],
            });
          });
        } else {
          require("fs").closeSync(fd);
          resolve({
            content: [{ type: "text", text: `📤 Gönderildi: "${message}"` }],
          });
        }
      });
    });
  }
);

server.tool(
  "get_serial_ports",
  "Sistemdeki tüm seri portları detaylı bilgileriyle listeler (vendor, model, seri no, rol)",
  {},
  async () => {
    const ports = await detectPorts();
    if (ports.length === 0) {
      return { content: [{ type: "text", text: "Bağlı seri port yok." }] };
    }

    const lines = ports.map((p) =>
      [
        `Port:    ${p.port}`,
        `Rol:     ${p.role} (${p.role === "upload" ? "sadece yükleme" : p.role === "monitor" ? "sadece monitor" : "her ikisi"})`,
        `Cihaz:   ${p.modelName || "Bilinmiyor"}`,
        `Vendor:  ${p.vendor}:${p.product}`,
        `Seri No: ${p.serial || "Bilinmiyor"}`,
        "─".repeat(40),
      ].join("\n")
    );

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
    library: z.string().describe("Kütüphane adı (ör: DHT sensor library, FastLED)"),
    version: z.string().optional().describe("Versiyon (ör: 1.4.0, belirtilmezse son sürüm)"),
  },
  async ({ library, version }) => {
    const libStr = version ? `"${library}@${version}"` : `"${library}"`;
    const r = await runCmd(`${ARDUINO_CLI} lib install ${libStr} 2>&1`, 60000);
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{
        type: "text",
        text: `${icon} "${library}" ${r.ok ? "kuruldu" : "kurulamadı"}:\n${r.stdout}\n${r.stderr}`.trim(),
      }],
    };
  }
);

server.tool(
  "uninstall_library",
  "Arduino kütüphanesini kaldırır",
  { library: z.string().describe("Kaldırılacak kütüphane adı") },
  async ({ library }) => {
    const r = await runCmd(`${ARDUINO_CLI} lib uninstall "${library}" 2>&1`, 30000);
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{
        type: "text",
        text: `${icon} "${library}" ${r.ok ? "kaldırıldı" : "kaldırılamadı"}:\n${r.stdout}\n${r.stderr}`.trim(),
      }],
    };
  }
);

server.tool(
  "list_libraries",
  "Kurulu Arduino kütüphanelerini listeler",
  {
    filter: z.string().optional().describe("Filtreleme terimi (opsiyonel)"),
  },
  async ({ filter }) => {
    const r = await runCmd(`${ARDUINO_CLI} lib list 2>&1`, 30000);
    if (!r.ok) return { content: [{ type: "text", text: `Hata: ${r.stderr}` }] };

    let output = r.stdout;
    if (filter) {
      output = output
        .split("\n")
        .filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
        .join("\n");
    }

    return { content: [{ type: "text", text: output || "Kurulu kütüphane yok." }] };
  }
);

server.tool(
  "search_library",
  "Arduino kütüphane deposunda arama yapar",
  { query: z.string().describe("Arama terimi (ör: DHT, NeoPixel, MQTT)") },
  async ({ query }) => {
    const r = await runCmd(`${ARDUINO_CLI} lib search "${query}" 2>&1`, 30000);
    if (!r.ok) return { content: [{ type: "text", text: `Hata: ${r.stderr}` }] };
    const lines = r.stdout.split("\n").slice(0, 50).join("\n");
    return { content: [{ type: "text", text: lines || "Sonuç bulunamadı." }] };
  }
);

server.tool(
  "update_libraries",
  "Tüm kurulu Arduino kütüphanelerini günceller",
  {},
  async () => {
    const r = await runCmd(`${ARDUINO_CLI} lib upgrade 2>&1`, 120000);
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{
        type: "text",
        text: `${icon} Kütüphane güncellemesi ${r.ok ? "tamamlandı" : "başarısız"}:\n${r.stdout}\n${r.stderr}`.trim(),
      }],
    };
  }
);

server.tool(
  "install_board",
  "Kart platform paketini kurar (ör: esp32:esp32, arduino:avr)",
  { platform: z.string().describe("Platform (ör: esp32:esp32, arduino:avr)") },
  async ({ platform }) => {
    if (platform.startsWith("esp32")) {
      await runCmd(
        `${ARDUINO_CLI} config set board_manager.additional_urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json 2>&1`
      );
      await runCmd(`${ARDUINO_CLI} core update-index 2>&1`, 30000);
    }
    const r = await runCmd(`${ARDUINO_CLI} core install ${platform} 2>&1`, 300000);
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [{
        type: "text",
        text: `${icon} ${platform} ${r.ok ? "kuruldu" : "kurulamadı"}:\n${r.stdout}\n${r.stderr}`.trim(),
      }],
    };
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
    return {
      content: [{
        type: "text",
        text: `${icon} Kart güncellemesi ${r.ok ? "tamamlandı" : "başarısız"}:\n${r.stdout}\n${r.stderr}`.trim(),
      }],
    };
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
  {
    sketch: z.string().optional().describe("Açılacak sketch adı (opsiyonel)"),
  },
  async ({ sketch }) => {
    const idePath =
      process.env.ARDUINO_IDE_PATH ||
      path.join(os.homedir(), "Applications", "arduino-ide_2.3.10_Linux_64bit.AppImage");

    let cmd = `"${idePath}" --no-sandbox`;
    if (sketch) {
      const file = path.join(SKETCHES_DIR, sketch, `${sketch}.ino`);
      cmd += ` "${file}"`;
    }
    cmd += " &>/dev/null &";
    await runCmd(cmd, 5000);
    return {
      content: [{
        type: "text",
        text: sketch ? `✅ Arduino IDE açılıyor: ${sketch}` : `✅ Arduino IDE açılıyor...`,
      }],
    };
  }
);

server.tool(
  "arduino_cli_check",
  "Arduino CLI kurulu mu kontrol eder. Kurulu değilse kurulum komutunu verir.",
  {},
  async () => {
    const r = await runCmd(`${ARDUINO_CLI} version`);
    if (r.ok) {
      return { content: [{ type: "text", text: `✅ Arduino CLI kurulu:\n${r.stdout}` }] };
    }
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
  "Arduino CLI yapılandırmasını gösterir veya board_manager URL'i ekler/listeler",
  {
    action: z.enum(["show", "add_url", "reset"]).default("show").describe("show: göster, add_url: URL ekle, reset: sıfırla"),
    url: z.string().optional().describe("Eklenecek board manager URL (action=add_url için)"),
  },
  async ({ action, url }) => {
    if (action === "show") {
      const r = await runCmd(`${ARDUINO_CLI} config dump 2>&1`);
      return { content: [{ type: "text", text: r.stdout || r.stderr }] };
    }
    if (action === "add_url" && url) {
      const r = await runCmd(
        `${ARDUINO_CLI} config add board_manager.additional_urls "${url}" 2>&1`
      );
      const icon = r.ok ? "✅" : "❌";
      return { content: [{ type: "text", text: `${icon} URL eklendi: ${url}\n${r.stdout}` }] };
    }
    if (action === "reset") {
      const r = await runCmd(`${ARDUINO_CLI} config init --overwrite 2>&1`);
      return { content: [{ type: "text", text: `✅ Config sıfırlandı.\n${r.stdout}` }] };
    }
    return { content: [{ type: "text", text: "❌ Geçersiz işlem." }] };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 arduino-mcp v3.0.0 started");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
