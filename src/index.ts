#!/usr/bin/env node
/**
 * arduino-mcp — MCP server for Arduino IDE & arduino-cli
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

const execAsync = promisify(exec);

// ─── Constants ───────────────────────────────────────────────────────────────

const ARDUINO_CLI = process.env.ARDUINO_CLI_PATH || "arduino-cli";
const SKETCHES_DIR =
  process.env.ARDUINO_SKETCHES_DIR || path.join(os.homedir(), "Arduino");
const CONFIG_FILE = path.join(os.homedir(), ".arduino-mcp.json");

// CH340/CH341/CH343 = upload-only UART bridge
const UPLOAD_VENDORS = new Set(["1a86", "10c4", "0403", "2341"]);
// ESP32-S3/S2 native USB
const NATIVE_USB_VENDOR = "303a";

// ─── Config ──────────────────────────────────────────────────────────────────

interface BoardConfig {
  fqbn: string;
  uploadPort: string;
  monitorPort: string;
  flashSize?: string;
  psram?: string;
  cdcOnBoot?: string;
  lastSeen: string;
}

interface Config {
  boards: Record<string, BoardConfig>;
  defaultBoard?: string;
}

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
  return opts.length > 0 ? `${board.fqbn}:${opts.join(",")}` : board.fqbn;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  await runCmd(
    `chmod 666 ${port} 2>/dev/null || sudo chmod 666 ${port} 2>/dev/null`
  );
}

// ─── Auto-detect ─────────────────────────────────────────────────────────────

interface DetectedPort {
  port: string;
  vendor: string;
  serial: string;
  role: "upload" | "monitor" | "both";
}

async function detectPorts(): Promise<DetectedPort[]> {
  const devList = await runCmd("ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null");
  if (!devList.stdout) return [];

  const ports: DetectedPort[] = [];
  for (const port of devList.stdout.split("\n").filter(Boolean)) {
    const udev = await runCmd(
      `udevadm info --query=all --name=${port} 2>/dev/null`
    );
    if (!udev.ok) continue;

    const vendor =
      udev.stdout.match(/ID_VENDOR_ID=([0-9a-f]+)/i)?.[1]?.toLowerCase() || "";
    const serial =
      udev.stdout.match(/ID_SERIAL_SHORT=([^\n]+)/)?.[1]?.trim() || "";

    if (!vendor) continue;

    let role: DetectedPort["role"] = "both";
    if (UPLOAD_VENDORS.has(vendor)) role = "upload";
    else if (vendor === NATIVE_USB_VENDOR) role = "monitor";

    ports.push({ port, vendor, serial, role });
  }
  return ports;
}

async function autoDetect(): Promise<{
  uploadPort: string;
  monitorPort: string;
  serial: string;
  fqbn?: string;
} | null> {
  const ports = await detectPorts();
  if (ports.length === 0) return null;

  const uploadPort = ports.find(
    (p) => p.role === "upload" || p.role === "both"
  );
  const monitorPort = ports.find(
    (p) => p.role === "monitor" || p.role === "both"
  );

  const up = uploadPort || monitorPort;
  const mp = monitorPort || uploadPort;
  if (!up || !mp) return null;

  // Try to get FQBN from arduino-cli
  const boardList = await runCmd(`${ARDUINO_CLI} board list 2>/dev/null`);
  let fqbn: string | undefined;
  if (boardList.ok) {
    for (const line of boardList.stdout.split("\n")) {
      if (line.includes(up.port) || line.includes(mp.port)) {
        const match = line.match(/esp32:\S+|arduino:\S+/);
        if (match) fqbn = match[0];
      }
    }
  }

  return {
    uploadPort: up.port,
    monitorPort: mp.port,
    serial: up.serial || mp.serial,
    fqbn,
  };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "arduino-mcp",
  version: "2.0.0",
});

// ─── detect_board ─────────────────────────────────────────────────────────────

server.tool(
  "detect_board",
  "Bağlı Arduino/ESP32 kartını otomatik tanır, port ve FQBN bilgilerini kaydeder. Her oturumun başında çalıştır.",
  { save: z.boolean().default(true).describe("Kartı hafızaya kaydet") },
  async ({ save }) => {
    const detected = await autoDetect();
    if (!detected) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Bağlı kart bulunamadı. USB kablosunu kontrol et.",
          },
        ],
      };
    }

    const boardList = await runCmd(`${ARDUINO_CLI} board list 2>&1`);
    let boardName = "Bilinmiyor";
    let fqbn = detected.fqbn;

    if (boardList.ok) {
      for (const line of boardList.stdout.split("\n")) {
        if (
          line.includes(detected.uploadPort) ||
          line.includes(detected.monitorPort)
        ) {
          const parts = line.trim().split(/\s{2,}/);
          if (parts.length >= 3) boardName = parts[2] || boardName;
          if (parts.length >= 4 && !fqbn) fqbn = parts[3];
        }
      }
    }

    let savedMsg = "";
    if (save) {
      const serial = detected.serial || `unknown_${Date.now()}`;
      const cfg = await loadConfig();
      const baseFqbn =
        fqbn?.split(":").slice(0, 3).join(":") || "esp32:esp32:esp32s3";

      cfg.boards[serial] = {
        fqbn: baseFqbn,
        uploadPort: detected.uploadPort,
        monitorPort: detected.monitorPort,
        cdcOnBoot: "default",
        flashSize: "16M",
        psram: baseFqbn.includes("s3") ? "opi" : undefined,
        lastSeen: new Date().toISOString(),
      };
      cfg.defaultBoard = serial;
      await saveConfig(cfg);
      savedMsg = "\n\n✅ Kart hafızaya kaydedildi.";
    }

    return {
      content: [
        {
          type: "text",
          text: [
            `🔍 Kart Tespit Edildi`,
            `Kart: ${boardName}`,
            `Yükleme Portu: ${detected.uploadPort}`,
            `Monitor Portu: ${detected.monitorPort}`,
            `FQBN: ${fqbn || "Tespit edilemedi"}`,
            `Seri No: ${detected.serial || "Bilinmiyor"}`,
            savedMsg,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  }
);

// ─── board_config ─────────────────────────────────────────────────────────────

server.tool(
  "board_config",
  "Kaydedilmiş kart ayarlarını göster veya güncelle (port, FQBN, flash size vb.)",
  {
    action: z.enum(["show", "set"]).default("show"),
    fqbn: z.string().optional().describe("Kart FQBN (ör: esp32:esp32:esp32s3)"),
    upload_port: z.string().optional().describe("Yükleme portu"),
    monitor_port: z.string().optional().describe("Monitor portu"),
    flash_size: z.string().optional().describe("Flash boyutu (4M/8M/16M)"),
    psram: z.string().optional().describe("PSRAM (opi/qspi/disabled)"),
    cdc_on_boot: z.string().optional().describe("CDCOnBoot (default/cdc)"),
  },
  async ({ action, fqbn, upload_port, monitor_port, flash_size, psram, cdc_on_boot }) => {
    const cfg = await loadConfig();

    if (action === "show") {
      if (!cfg.defaultBoard || !cfg.boards[cfg.defaultBoard]) {
        return {
          content: [
            {
              type: "text",
              text: '❌ Kayıtlı kart yok. Önce "detect_board" çalıştır.',
            },
          ],
        };
      }
      const b = cfg.boards[cfg.defaultBoard];
      return {
        content: [
          {
            type: "text",
            text: [
              "📋 Kayıtlı Kart Ayarları",
              `Seri No: ${cfg.defaultBoard}`,
              `FQBN: ${buildFqbn(b)}`,
              `Yükleme Portu: ${b.uploadPort}`,
              `Monitor Portu: ${b.monitorPort}`,
              `Flash: ${b.flashSize || "varsayılan"}`,
              `PSRAM: ${b.psram || "varsayılan"}`,
              `CDC on Boot: ${b.cdcOnBoot || "varsayılan"}`,
              `Son Görülme: ${b.lastSeen}`,
            ].join("\n"),
          },
        ],
      };
    }

    if (!cfg.defaultBoard) {
      return {
        content: [
          { type: "text", text: '❌ Önce "detect_board" çalıştır.' },
        ],
      };
    }

    const b = cfg.boards[cfg.defaultBoard];
    if (fqbn) b.fqbn = fqbn.split(":").slice(0, 3).join(":");
    if (upload_port) b.uploadPort = upload_port;
    if (monitor_port) b.monitorPort = monitor_port;
    if (flash_size) b.flashSize = flash_size;
    if (psram) b.psram = psram;
    if (cdc_on_boot) b.cdcOnBoot = cdc_on_boot;
    b.lastSeen = new Date().toISOString();
    await saveConfig(cfg);

    return {
      content: [
        {
          type: "text",
          text: `✅ Ayarlar güncellendi.\nFQBN: ${buildFqbn(b)}\nYükleme: ${b.uploadPort}\nMonitor: ${b.monitorPort}`,
        },
      ],
    };
  }
);

// ─── list_boards ─────────────────────────────────────────────────────────────

server.tool(
  "list_boards",
  "Bağlı Arduino/ESP32 kartlarını ve portlarını listeler",
  {},
  async () => {
    const r = await runCmd(`${ARDUINO_CLI} board list 2>&1`);
    if (!r.ok || !r.stdout) {
      const ports = await runCmd("ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null");
      const usb = await runCmd(
        "lsusb 2>/dev/null | grep -iE 'arduino|esp|ch340|cp210|ftdi|ch343'"
      );
      return {
        content: [
          {
            type: "text",
            text: `Portlar:\n${ports.stdout || "Yok"}\n\nUSB Cihazlar:\n${usb.stdout || "Yok"}`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: r.stdout }] };
  }
);

// ─── list_sketches ───────────────────────────────────────────────────────────

server.tool(
  "list_sketches",
  "~/Arduino klasöründeki mevcut sketch'leri listeler",
  {},
  async () => {
    try {
      await fs.mkdir(SKETCHES_DIR, { recursive: true });
      const entries = await fs.readdir(SKETCHES_DIR, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (dirs.length === 0)
        return { content: [{ type: "text", text: "Henüz hiç sketch yok." }] };
      return {
        content: [
          {
            type: "text",
            text: `Sketch'ler (${SKETCHES_DIR}):\n${dirs.map((d) => `  • ${d}`).join("\n")}`,
          },
        ],
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text", text: `Hata: ${(e as Error).message}` }],
      };
    }
  }
);

// ─── create_sketch ───────────────────────────────────────────────────────────

server.tool(
  "create_sketch",
  "Yeni bir Arduino sketch'i oluşturur",
  {
    name: z.string().describe("Sketch adı (boşluksuz)"),
    code: z.string().optional().describe("Başlangıç kodu (opsiyonel)"),
  },
  async ({ name, code }) => {
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
    const dir = await ensureSketchDir(safeName);
    const file = path.join(dir, `${safeName}.ino`);

    const defaultCode =
      code ||
      `// ${safeName}
// Created with arduino-mcp

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
`;
    await fs.writeFile(file, defaultCode, "utf-8");
    return {
      content: [
        {
          type: "text",
          text: `✅ Sketch oluşturuldu: ${file}\n\n\`\`\`cpp\n${defaultCode}\n\`\`\``,
        },
      ],
    };
  }
);

// ─── read_sketch ─────────────────────────────────────────────────────────────

server.tool(
  "read_sketch",
  "Mevcut bir sketch'in kodunu okur",
  { name: z.string().describe("Sketch adı") },
  async ({ name }) => {
    const file = path.join(SKETCHES_DIR, name, `${name}.ino`);
    try {
      const code = await fs.readFile(file, "utf-8");
      return {
        content: [{ type: "text", text: `📄 ${file}:\n\`\`\`cpp\n${code}\n\`\`\`` }],
      };
    } catch {
      return {
        content: [{ type: "text", text: `❌ Sketch bulunamadı: ${file}` }],
      };
    }
  }
);

// ─── write_sketch ────────────────────────────────────────────────────────────

server.tool(
  "write_sketch",
  "Mevcut bir sketch'in kodunu günceller",
  {
    name: z.string().describe("Sketch adı"),
    code: z.string().describe("Yeni Arduino kodu"),
  },
  async ({ name, code }) => {
    const dir = await ensureSketchDir(name);
    const file = path.join(dir, `${name}.ino`);
    await fs.writeFile(file, code, "utf-8");
    return {
      content: [{ type: "text", text: `✅ Sketch güncellendi: ${file}` }],
    };
  }
);

// ─── compile_sketch ──────────────────────────────────────────────────────────

server.tool(
  "compile_sketch",
  "Sketch'i derler. FQBN belirtilmezse kayıtlı kart ayarlarını kullanır.",
  {
    name: z.string().describe("Sketch adı"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel)"),
  },
  async ({ name, fqbn }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? buildFqbn(board) : null);

    if (!resolvedFqbn) {
      return {
        content: [
          {
            type: "text",
            text: '❌ FQBN bulunamadı. Önce "detect_board" çalıştır veya fqbn parametresi geç.',
          },
        ],
      };
    }

    const dir = path.join(SKETCHES_DIR, name);
    const r = await runCmd(
      `${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}" "${dir}" 2>&1`,
      180000
    );
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [
        {
          type: "text",
          text: `${icon} Derleme ${r.ok ? "başarılı" : "başarısız"} (${resolvedFqbn}):\n${r.stdout}\n${r.stderr}`.trim(),
        },
      ],
    };
  }
);

// ─── upload_sketch ───────────────────────────────────────────────────────────

server.tool(
  "upload_sketch",
  "Sketch'i kartına yükler. Port ve FQBN belirtilmezse kayıtlı ayarları kullanır. Portu otomatik serbest bırakır.",
  {
    name: z.string().describe("Sketch adı"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel)"),
    port: z.string().optional().describe("Yükleme portu (opsiyonel)"),
  },
  async ({ name, fqbn, port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? buildFqbn(board) : null);
    const resolvedPort = port || board?.uploadPort || null;

    if (!resolvedFqbn || !resolvedPort) {
      return {
        content: [
          { type: "text", text: '❌ Port veya FQBN bulunamadı. Önce "detect_board" çalıştır.' },
        ],
      };
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
      content: [
        {
          type: "text",
          text: `${icon} Yükleme ${r.ok ? "başarılı" : "başarısız"} → ${resolvedPort}:\n${r.stdout}\n${r.stderr}`.trim(),
        },
      ],
    };
  }
);

// ─── compile_and_upload ──────────────────────────────────────────────────────

server.tool(
  "compile_and_upload",
  "Sketch'i derler ve kartına yükler (tek adımda). Kayıtlı kart ayarlarını kullanır.",
  {
    name: z.string().describe("Sketch adı"),
    fqbn: z.string().optional().describe("Kart FQBN (opsiyonel)"),
    port: z.string().optional().describe("Yükleme portu (opsiyonel)"),
  },
  async ({ name, fqbn, port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedFqbn = fqbn || (board ? buildFqbn(board) : null);
    const resolvedPort = port || board?.uploadPort || null;

    if (!resolvedFqbn || !resolvedPort) {
      return {
        content: [
          { type: "text", text: '❌ Port veya FQBN bulunamadı. Önce "detect_board" çalıştır.' },
        ],
      };
    }

    const dir = path.join(SKETCHES_DIR, name);

    const compile = await runCmd(
      `${ARDUINO_CLI} compile --fqbn "${resolvedFqbn}" "${dir}" 2>&1`,
      180000
    );
    if (!compile.ok) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Derleme başarısız:\n${compile.stdout}\n${compile.stderr}`.trim(),
          },
        ],
      };
    }

    await freePort(resolvedPort);
    await new Promise((r) => setTimeout(r, 500));
    await fixPortPermission(resolvedPort);

    const upload = await runCmd(
      `${ARDUINO_CLI} upload -p ${resolvedPort} --fqbn "${resolvedFqbn}" "${dir}" 2>&1`,
      180000
    );

    return {
      content: [
        {
          type: "text",
          text: `✅ Derleme başarılı\n${upload.ok ? "✅" : "❌"} Yükleme ${upload.ok ? "başarılı" : "başarısız"} → ${resolvedPort}\n\n${upload.stdout}\n${upload.stderr}`.trim(),
        },
      ],
    };
  }
);

// ─── serial_monitor ──────────────────────────────────────────────────────────

server.tool(
  "serial_monitor",
  "Serial port'tan veri okur. Port belirtilmezse kayıtlı monitor portunu kullanır.",
  {
    port: z.string().optional().describe("Seri port (opsiyonel)"),
    baud: z.number().default(115200).describe("Baud rate"),
    seconds: z.number().default(5).describe("Kaç saniye okusun"),
  },
  async ({ port, baud, seconds }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.monitorPort || "/dev/ttyACM0";

    await fixPortPermission(resolvedPort);

    return new Promise((resolve) => {
      let output = "";
      exec(`stty -F ${resolvedPort} ${baud} raw -echo 2>/dev/null`);
      const proc = spawn("timeout", [String(seconds), "cat", resolvedPort]);

      proc.stdout.on("data", (d: Buffer) => {
        output += d.toString();
      });
      proc.stderr.on("data", (d: Buffer) => {
        output += d.toString();
      });

      proc.on("close", () => {
        const clean = output
          .split("\n")
          .map((l) => l.replace(/[^\x20-\x7E]/g, "").trim())
          .filter(Boolean)
          .join("\n");

        resolve({
          content: [
            {
              type: "text",
              text: clean
                ? `📡 ${resolvedPort} @ ${baud} (${seconds}s):\n${clean}`
                : `📡 ${resolvedPort}: ${seconds}s içinde veri alınamadı.`,
            },
          ],
        });
      });
    });
  }
);

// ─── install_board ───────────────────────────────────────────────────────────

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
    const r = await runCmd(
      `${ARDUINO_CLI} core install ${platform} 2>&1`,
      300000
    );
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [
        {
          type: "text",
          text: `${icon} ${platform} ${r.ok ? "kuruldu" : "kurulamadı"}:\n${r.stdout}\n${r.stderr}`.trim(),
        },
      ],
    };
  }
);

// ─── install_library ─────────────────────────────────────────────────────────

server.tool(
  "install_library",
  "Arduino kütüphanesi kurar (ör: DHT sensor library, FastLED, WiFi)",
  { library: z.string().describe("Kütüphane adı") },
  async ({ library }) => {
    const r = await runCmd(
      `${ARDUINO_CLI} lib install "${library}" 2>&1`,
      60000
    );
    const icon = r.ok ? "✅" : "❌";
    return {
      content: [
        {
          type: "text",
          text: `${icon} "${library}" ${r.ok ? "kuruldu" : "kurulamadı"}:\n${r.stdout}\n${r.stderr}`.trim(),
        },
      ],
    };
  }
);

// ─── search_library ──────────────────────────────────────────────────────────

server.tool(
  "search_library",
  "Arduino kütüphane deposunda arama yapar",
  { query: z.string().describe("Arama terimi (ör: DHT, NeoPixel, MQTT)") },
  async ({ query }) => {
    const r = await runCmd(
      `${ARDUINO_CLI} lib search "${query}" 2>&1`,
      30000
    );
    if (!r.ok)
      return { content: [{ type: "text", text: `Hata: ${r.stderr}` }] };
    const lines = r.stdout.split("\n").slice(0, 40).join("\n");
    return {
      content: [{ type: "text", text: lines || "Sonuç bulunamadı." }],
    };
  }
);

// ─── open_arduino_ide ────────────────────────────────────────────────────────

server.tool(
  "open_arduino_ide",
  "Arduino IDE 2'yi açar. Sketch adı belirtilirse o sketch ile açılır.",
  {
    sketch: z.string().optional().describe("Açılacak sketch adı (opsiyonel)"),
    ide_path: z
      .string()
      .optional()
      .describe("Arduino IDE yolu (opsiyonel, varsayılan otomatik)"),
  },
  async ({ sketch, ide_path }) => {
    const idePath =
      ide_path ||
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
      content: [
        {
          type: "text",
          text: sketch
            ? `✅ Arduino IDE açılıyor: ${sketch}`
            : `✅ Arduino IDE açılıyor...`,
        },
      ],
    };
  }
);

// ─── board_info ──────────────────────────────────────────────────────────────

server.tool(
  "board_info",
  "Bağlı kartın detaylı bilgisini gösterir",
  {
    port: z.string().optional().describe("Seri port (opsiyonel)"),
  },
  async ({ port }) => {
    const cfg = await loadConfig();
    const board = cfg.defaultBoard ? cfg.boards[cfg.defaultBoard] : null;
    const resolvedPort = port || board?.uploadPort || "/dev/ttyACM0";

    const r = await runCmd(
      `${ARDUINO_CLI} board info --port ${resolvedPort} 2>&1`
    );
    if (!r.ok || !r.stdout) {
      const udev = await runCmd(
        `udevadm info --query=all --name=${resolvedPort} 2>&1 | grep -E "ID_VENDOR|ID_MODEL|ID_SERIAL"`
      );
      return {
        content: [{ type: "text", text: udev.stdout || "Kart bilgisi alınamadı." }],
      };
    }
    return { content: [{ type: "text", text: r.stdout }] };
  }
);

// ─── arduino_cli_check ───────────────────────────────────────────────────────

server.tool(
  "arduino_cli_check",
  "Arduino CLI kurulu mu kontrol eder, kurulu değilse kurulum talimatlarını verir",
  {},
  async () => {
    const r = await runCmd(`${ARDUINO_CLI} version`);
    if (r.ok) {
      return {
        content: [{ type: "text", text: `✅ Arduino CLI kurulu:\n${r.stdout}` }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `❌ Arduino CLI bulunamadı.\nKurulum:\n  curl -fsSL https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_64bit.tar.gz -o /tmp/arduino-cli.tar.gz\n  tar -xzf /tmp/arduino-cli.tar.gz -C /tmp/\n  sudo mv /tmp/arduino-cli /usr/local/bin/`,
        },
      ],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 arduino-mcp v2.0.0 started");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
