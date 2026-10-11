import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cli, esptool } from "../lib/arduino.js";
import {
  buildFqbn, getDefaultBoard, getPlatformFamily, isEspFamily, loadConfig, mergeOptions, saveConfig, splitFqbn,
  type BoardConfig,
} from "../lib/config.js";
import { assertPortAccessible, autoDetect, detectPorts, releasePort, type DetectedPort } from "../lib/ports.js";
import { assertFqbn, assertSerialPort, parseBoardOptions, UserError } from "../lib/validate.js";
import { serialBuffer } from "../serial-buffer.js";
import { DESTRUCTIVE, ok, READ_ONLY, resolvePort, WRITES } from "./util.js";

function roleLabel(p: DetectedPort): string {
  return p.role === "upload" ? "upload" : p.role === "monitor" ? "monitor" : "upload+monitor";
}

function describePort(p: DetectedPort): string {
  const boards = p.boards.length ? `  ${p.boards.map((b) => `${b.name} (${b.fqbn})`).join(" | ")}` : "";
  return `  ${p.port}  [${roleLabel(p)}]  ${p.description || "?"}  USB ${p.vendor || "?"}:${p.product || "?"}  SN:${p.serial || "?"}${boards}`;
}

/** Validates a single menu option value (e.g. "opi", "16M"). Empty string means "unset". */
function optionValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  parseBoardOptions(`${key}=${value}`);
  return value;
}

export function registerBoardTools(server: McpServer): void {
  server.registerTool(
    "detect_board",
    {
      title: "Detect board",
      description:
        "Detects the connected board (upload/monitor ports, FQBN) and saves it as the default board. " +
        "Works with AVR (Uno/Mega/Nano), ESP32/ESP32-S3/C3/S2, ESP8266, RP2040, SAMD and any board arduino-cli knows. " +
        "Handles ESP32-S3 boards with two USB ports. Settings already saved for the same board are kept.",
      inputSchema: { save: z.boolean().default(true).describe("Save as the default board") },
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ save }) => {
      const d = await autoDetect();
      if (!d) {
        return ok(
          "❌ No board found.\n\nCheck:\n• Is the USB cable plugged in?\n• Does the cable carry data (not charge-only)?\n" +
          "• Is arduino-cli installed? (arduino_cli_check)"
        );
      }

      const lines = ["🔍 Board detected"];
      const samePort = d.uploadPort === d.monitorPort;
      lines.push(`Board:        ${d.boardName || "unknown"}`);
      lines.push(`FQBN:         ${d.fqbn || "not detected"}`);
      if (samePort) {
        lines.push(`Port:         ${d.uploadPort} (upload + monitor)`);
      } else {
        lines.push(`Upload port:  ${d.uploadPort}`, `Monitor port: ${d.monitorPort}`);
      }
      lines.push(`Serial no:    ${d.serial || "unknown"}`);
      if (d.alternatives.length) {
        lines.push(`Also matches: ${d.alternatives.map((b) => b.fqbn).join(", ")} (change with board_config if needed)`);
      }
      const others = d.ports.filter((p) => p.port !== d.uploadPort && p.port !== d.monitorPort);
      if (others.length) {
        lines.push("", "⚠️ Other USB serial ports are connected; if the wrong one was picked, set it with board_config:");
        lines.push(...others.map(describePort));
      }

      if (save) {
        const cfg = await loadConfig();
        const key = d.serial || `unknown_${Date.now()}`;
        const prev = cfg.boards[key];
        const fqbn = d.fqbn ? splitFqbn(d.fqbn).base : prev?.fqbn || "";
        // Keep user-chosen options (flash size, PSRAM, ...) unless the board type changed.
        const base: Partial<BoardConfig> = prev && prev.fqbn === fqbn ? prev : {};
        cfg.boards[key] = {
          ...base,
          fqbn,
          family: fqbn ? getPlatformFamily(fqbn) : "unknown",
          uploadPort: d.uploadPort,
          monitorPort: d.monitorPort,
          boardName: d.boardName || prev?.boardName,
          lastSeen: new Date().toISOString(),
        };
        cfg.defaultBoard = key;
        await saveConfig(cfg);
        lines.push("", "✅ Saved as default board.");
        if (!fqbn) {
          lines.push(
            "⚠️ The board type could not be identified (common for clones with CH340/CP210x chips). " +
            'Set it with board_config, e.g. fqbn "arduino:avr:nano".'
          );
        }
      }
      return ok(lines.join("\n"));
    }
  );

  server.registerTool(
    "board_config",
    {
      title: "Show or change board settings",
      description:
        "Shows or updates the saved default board. ESP32 options: flash_size, psram, cdc_on_boot, partition_scheme, upload_speed. " +
        "ESP8266: upload_speed. Any other board menu option (e.g. Nano's cpu=atmega328old) goes into extra_options. " +
        "Pass an empty string to clear an option. Use board_options to see what a board supports.",
      inputSchema: {
        action: z.enum(["show", "set"]).default("show"),
        fqbn: z.string().optional().describe("Board FQBN, e.g. arduino:avr:uno or esp32:esp32:esp32s3 (options after the 3rd ':' are kept)"),
        upload_port: z.string().optional().describe("Upload port, e.g. /dev/ttyACM1, /dev/cu.usbserial-110, COM4"),
        monitor_port: z.string().optional().describe("Serial monitor port"),
        flash_size: z.string().optional().describe("ESP32 FlashSize, e.g. 4M, 8M, 16M"),
        psram: z.string().optional().describe("ESP32 PSRAM, e.g. disabled, enabled, opi"),
        cdc_on_boot: z.string().optional().describe("ESP32-S2/S3/C3 CDCOnBoot: default (off) or cdc"),
        partition_scheme: z.string().optional().describe("ESP32 PartitionScheme, e.g. default, huge_app, min_spiffs, no_ota"),
        upload_speed: z.string().optional().describe("ESP32/ESP8266 upload baud, e.g. 921600, 460800, 115200"),
        extra_options: z.string().optional().describe("Other menu options as key=value,key2=value2 (replaces the previous value)"),
      },
      annotations: WRITES,
    },
    async (args) => {
      const cfg = await loadConfig();

      if (args.action === "show") {
        const b = getDefaultBoard(cfg);
        if (!b) return ok('❌ No saved board. Run "detect_board" or "board_config" with action=set and fqbn.');
        const esp = b.family === "esp32";
        return ok([
          "📋 Saved board",
          `ID:             ${cfg.defaultBoard}`,
          `Board:          ${b.boardName || "unknown"}`,
          `Platform:       ${b.family}`,
          `FQBN:           ${buildFqbn(b) || "not set"}`,
          `Upload port:    ${b.uploadPort || "not set"}`,
          `Monitor port:   ${b.monitorPort || "not set"}`,
          esp ? `Flash:          ${b.flashSize || "board default"}` : null,
          esp ? `PSRAM:          ${b.psram || "board default"}` : null,
          esp ? `CDC on boot:    ${b.cdcOnBoot || "board default"}` : null,
          esp ? `Partition:      ${b.partitionScheme || "board default"}` : null,
          isEspFamily(b.family) ? `Upload speed:   ${b.uploadSpeed || "board default"}` : null,
          b.extraOptions ? `Extra options:  ${b.extraOptions}` : null,
          `Last seen:      ${b.lastSeen}`,
        ].filter((l) => l !== null).join("\n"));
      }

      // Create a manual entry when nothing was detected yet.
      if (!getDefaultBoard(cfg)) {
        if (!args.fqbn) throw new UserError('No saved board yet. Run "detect_board", or pass fqbn to create one manually.');
        cfg.boards.manual = { fqbn: "", family: "unknown", uploadPort: "", monitorPort: "", lastSeen: new Date().toISOString() };
        cfg.defaultBoard = "manual";
      }
      const b = getDefaultBoard(cfg)!;

      if (args.fqbn) {
        const { base, options } = splitFqbn(assertFqbn(args.fqbn));
        if (base !== b.fqbn) {
          // Options of a different board would make the FQBN invalid.
          b.extraOptions = undefined;
          b.flashSize = b.psram = b.cdcOnBoot = b.partitionScheme = b.uploadSpeed = undefined;
        }
        b.fqbn = base;
        b.family = getPlatformFamily(base);
        b.extraOptions = mergeOptions(b.extraOptions, options);
      }
      if (args.upload_port !== undefined) b.uploadPort = args.upload_port ? assertSerialPort(args.upload_port) : "";
      if (args.monitor_port !== undefined) b.monitorPort = args.monitor_port ? assertSerialPort(args.monitor_port) : "";
      if (args.flash_size !== undefined) b.flashSize = optionValue("FlashSize", args.flash_size);
      if (args.psram !== undefined) b.psram = optionValue("PSRAM", args.psram);
      if (args.cdc_on_boot !== undefined) b.cdcOnBoot = optionValue("CDCOnBoot", args.cdc_on_boot);
      if (args.partition_scheme !== undefined) b.partitionScheme = optionValue("PartitionScheme", args.partition_scheme);
      if (args.upload_speed !== undefined) b.uploadSpeed = optionValue("UploadSpeed", args.upload_speed);
      if (args.extra_options !== undefined) {
        parseBoardOptions(args.extra_options);
        b.extraOptions = args.extra_options.trim() || undefined;
      }
      b.lastSeen = new Date().toISOString();
      await saveConfig(cfg);

      return ok(`✅ Settings saved.\nFQBN: ${buildFqbn(b) || "not set"}\nUpload: ${b.uploadPort || "not set"} | Monitor: ${b.monitorPort || "not set"}`);
    }
  );

  server.registerTool(
    "board_options",
    {
      title: "List board menu options",
      description: "Lists all FQBN menu options of a board (flash size, PSRAM, CPU, partition scheme, ...) via arduino-cli board details.",
      inputSchema: { fqbn: z.string().optional().describe("Board FQBN (default: saved board)") },
      annotations: READ_ONLY,
    },
    async ({ fqbn }) => {
      const board = getDefaultBoard(await loadConfig());
      const resolved = fqbn || board?.fqbn;
      if (!resolved) throw new UserError('No FQBN known. Run "detect_board" or pass fqbn.');
      const r = await cli(["board", "details", "--fqbn", splitFqbn(assertFqbn(resolved)).base]);
      return ok(r.output || "No details returned.");
    }
  );

  server.registerTool(
    "list_boards",
    {
      title: "List connected boards",
      description: "Lists connected USB serial ports with their upload/monitor role, USB IDs and the boards arduino-cli matches.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const ports = await detectPorts();
      if (ports.length === 0) return ok("🔌 No USB serial devices connected.");
      return ok(["🔌 Connected ports:", ...ports.map(describePort)].join("\n"));
    }
  );

  server.registerTool(
    "board_info",
    {
      title: "Board details",
      description:
        "Shows details of the connected board: USB IDs, serial number, matching boards and, for ESP32/ESP8266, " +
        "chip type, revision, MAC address and flash size (via esptool; this briefly resets the chip).",
      inputSchema: { port: z.string().optional().describe("Port (default: saved upload port)") },
      annotations: WRITES,
    },
    async ({ port }) => {
      const resolved = await resolvePort("upload", port);
      const board = getDefaultBoard(await loadConfig());
      const info = (await detectPorts()).find((p) => p.port === resolved);

      const lines = [`🔎 ${resolved}`];
      if (info) {
        lines.push(
          `USB:         ${info.vendor || "?"}:${info.product || "?"}`,
          `Description: ${info.description || "?"}`,
          `Serial no:   ${info.serial || "?"}`,
          `Boards:      ${info.boards.map((b) => `${b.name} (${b.fqbn})`).join(", ") || "not identified"}`
        );
      } else {
        lines.push("Port is not in the list of connected USB serial devices.");
      }

      const esp = isEspFamily(board?.family) || info?.vendor === "303a" || !!info?.boards.some((b) => isEspFamily(getPlatformFamily(b.fqbn)));
      if (esp) {
        await assertPortAccessible(resolved);
        const resume = await serialBuffer.pause([resolved]);
        try {
          const r = await esptool(["--port", resolved, "flash_id"]);
          lines.push("", "esptool:", r.output || "(no output)");
        } finally {
          lines.push(...(await resume()));
        }
      }
      return ok(lines.join("\n"));
    }
  );

  server.registerTool(
    "erase_flash",
    {
      title: "Erase ESP flash",
      description: "Erases the entire flash of an ESP32/ESP8266 (sketch, file system, NVS/WiFi settings). Not available for other boards.",
      inputSchema: {
        port: z.string().optional().describe("Port (default: saved upload port)"),
        free_port: z.boolean().default(true).describe("Stop other programs that keep the port open"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ port, free_port }) => {
      const board = getDefaultBoard(await loadConfig());
      if (board && board.family !== "unknown" && !isEspFamily(board.family)) {
        throw new UserError(`erase_flash only works on ESP32/ESP8266 boards; the saved board is "${board.family}".`);
      }
      const resolved = await resolvePort("upload", port);
      const notes: string[] = [];
      const resume = await serialBuffer.pause([resolved, ...(board?.monitorPort ? [board.monitorPort] : [])]);
      let r;
      try {
        if (free_port) {
          const stopped = await releasePort(resolved);
          if (stopped.length) notes.push(`Stopped processes holding ${resolved}: ${stopped.join(", ")}`);
        }
        await assertPortAccessible(resolved);
        r = await esptool(["--port", resolved, "erase_flash"], 120_000);
      } finally {
        notes.push(...(await resume()));
      }
      return ok([`${r.ok ? "✅" : "❌"} Flash erase ${r.ok ? "completed" : "failed"}:`, r.output, ...notes].filter(Boolean).join("\n"));
    }
  );
}
