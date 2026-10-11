import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cli, esptool, withExclusivePort } from "../lib/arduino.js";
import {
  applyBoardOptions, buildFqbn, getDefaultBoard, getPlatformFamily, isEspFamily, loadConfig, optionKey, setBoardOption,
  splitFqbn, updateConfig, type OptionField,
  type BoardConfig,
} from "../lib/config.js";
import { autoDetect, detectPorts, pickPorts, type DetectedPort } from "../lib/ports.js";
import { assertFqbn, assertSerialPort, parseBoardOptions, UserError } from "../lib/validate.js";
import { DESTRUCTIVE, fail, ok, READ_ONLY, reply, resolvePort, WRITES } from "./util.js";

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
        return fail(
          "❌ No board found.\n\nCheck:\n• Is the USB cable plugged in?\n• Does the cable carry data (not charge-only)?\n" +
          "• Is arduino-cli installed? (arduino_cli_check)"
        );
      }

      // What gets saved: by default the detected board; a board type the user
      // chose earlier (board_config, or one of several matches) is kept.
      let fqbn = d.fqbn ? splitFqbn(d.fqbn).base : "";
      let boardName = d.boardName;
      let keptChoice = false;
      let manualNote = "";
      if (save) {
        ({ fqbn, boardName, keptChoice, manualNote } = await updateConfig((cfg) => {
          const key = d.serial || `unknown_${Date.now()}`;
          let prev: BoardConfig | undefined = cfg.boards[key];
          const candidates = [d.fqbn, ...d.alternatives.map((b) => b.fqbn)]
            .filter((f): f is string => !!f)
            .map((f) => splitFqbn(f).base);
          // A board set up by hand (board_config) before the first detection
          // becomes this board's entry, if it fits what was detected.
          const manual = cfg.boards.manual;
          let manualNote = "";
          if (!prev && manual?.fqbn && cfg.defaultBoard === "manual") {
            if (candidates.length === 0 || candidates.includes(manual.fqbn)) {
              prev = manual;
              delete cfg.boards.manual;
            } else {
              manualNote = `Your manually configured board (${manual.fqbn}) does not match the detected board; ` +
                'it is kept as "manual" and can be restored with board_config.';
            }
          }
          const keepPrev = !!prev?.fqbn && (!!prev.fqbnSetByUser || candidates.length === 0 || candidates.includes(prev.fqbn));
          const chosen = keepPrev ? prev!.fqbn : candidates[0] ?? "";
          // Keep the saved options (flash size, PSRAM, ...) unless the board type changed.
          const base: Partial<BoardConfig> = prev && prev.fqbn === chosen ? prev : {};
          const name = keepPrev ? prev!.boardName || d.boardName : d.boardName || prev?.boardName;
          cfg.boards[key] = {
            ...base,
            fqbn: chosen,
            family: chosen ? getPlatformFamily(chosen) : "unknown",
            uploadPort: d.uploadPort,
            monitorPort: d.monitorPort,
            boardName: name,
            fqbnSetByUser: keepPrev ? prev!.fqbnSetByUser : undefined,
            lastSeen: new Date().toISOString(),
          };
          cfg.defaultBoard = key;
          return { fqbn: chosen, boardName: name, keptChoice: keepPrev && candidates.length > 0 && candidates[0] !== chosen, manualNote };
        }));
      }

      const lines = ["🔍 Board detected"];
      const samePort = d.uploadPort === d.monitorPort;
      lines.push(`Board:        ${boardName || "unknown"}`);
      lines.push(`FQBN:         ${fqbn || "not detected"}`);
      if (samePort) {
        lines.push(`Port:         ${d.uploadPort} (upload + monitor)`);
      } else {
        lines.push(`Upload port:  ${d.uploadPort}`, `Monitor port: ${d.monitorPort}`);
      }
      lines.push(`Serial no:    ${d.serial || "unknown"}`);
      if (keptChoice) {
        lines.push(`Keeping your board choice ${fqbn} (arduino-cli's first match is ${d.fqbn}).`);
      }
      if (manualNote) lines.push(`⚠️ ${manualNote}`);
      const others = [d.fqbn, ...d.alternatives.map((b) => b.fqbn)].filter((f) => f && splitFqbn(f).base !== fqbn);
      if (others.length) {
        lines.push(`Also matches: ${others.join(", ")} (change with board_config if needed)`);
      }
      if (d.paired) {
        lines.push("(Two USB ports were combined as one dual-USB board. If they are two different boards, set the ports with board_config.)");
      }
      if (d.otherPorts.length) {
        lines.push("", "⚠️ Other boards are connected; if the wrong one was picked, set the ports with board_config:");
        lines.push(...d.otherPorts.map(describePort));
      }
      if (save) {
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
      if (args.action === "show") {
        const cfg = await loadConfig();
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

      return updateConfig((cfg) => {
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
          b.fqbnSetByUser = true;
          if (options) applyBoardOptions(b, options);
        }
        if (args.upload_port !== undefined) b.uploadPort = args.upload_port ? assertSerialPort(args.upload_port) : "";
        if (args.monitor_port !== undefined) b.monitorPort = args.monitor_port ? assertSerialPort(args.monitor_port) : "";
        if (args.extra_options !== undefined) {
          parseBoardOptions(args.extra_options);
          b.extraOptions = undefined;
          applyBoardOptions(b, args.extra_options);
        }

        const notes: string[] = [];
        const fieldArgs: Array<[OptionField, string, string | undefined]> = [
          ["flashSize", "flash_size", args.flash_size],
          ["psram", "psram", args.psram],
          ["cdcOnBoot", "cdc_on_boot", args.cdc_on_boot],
          ["partitionScheme", "partition_scheme", args.partition_scheme],
          ["uploadSpeed", "upload_speed", args.upload_speed],
        ];
        for (const [field, argName, value] of fieldArgs) {
          if (value === undefined) continue;
          setBoardOption(b, field, optionValue(argName, value));
          if (value && !optionKey(b.family, field)) {
            notes.push(`⚠️ ${argName} has no effect on ${b.family} boards; use extra_options for their menu options.`);
          }
        }
        b.lastSeen = new Date().toISOString();
        return ok([
          "✅ Settings saved.",
          `FQBN: ${buildFqbn(b) || "not set"}`,
          `Upload: ${b.uploadPort || "not set"} | Monitor: ${b.monitorPort || "not set"}`,
          ...notes,
        ].join("\n"));
      });
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
      return reply(r.ok, r.output || "No details returned.");
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
      const board = getDefaultBoard(await loadConfig());
      const ports = await detectPorts(); // scanned once, also used to pick a default port
      const resolved = port ? assertSerialPort(port) : board?.uploadPort || pickPorts(ports)?.uploadPort;
      if (!resolved) throw new UserError('No serial port found. Plug in the board and run "detect_board", or pass port.');
      const info = ports.find((p) => p.port === resolved);

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

      // Decide from the port itself; the saved board only counts for its own ports
      // (esptool on an Uno would reset it and fail confusingly).
      const espByPort = !!info && (info.vendor === "303a" || info.boards.some((b) => isEspFamily(getPlatformFamily(b.fqbn))));
      const otherBoardByPort = !!info && info.boards.length > 0 && !espByPort;
      const isSavedBoardPort = !!board && (resolved === board.uploadPort || resolved === board.monitorPort);
      if (espByPort || (isSavedBoardPort && isEspFamily(board!.family) && !otherBoardByPort)) {
        const { result: r, notes } = await withExclusivePort(resolved, { freePort: false }, () =>
          esptool(["--port", resolved, "flash_id"])
        );
        lines.push("", "esptool:", r.output || "(no output)", ...notes);
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
      const { result: r, notes } = await withExclusivePort(resolved, { alsoPause: [board?.monitorPort], freePort: free_port }, () =>
        esptool(["--port", resolved, "erase_flash"], 120_000)
      );
      return reply(r.ok, [`${r.ok ? "✅" : "❌"} Flash erase ${r.ok ? "completed" : "failed"}:`, r.output, ...notes].filter(Boolean).join("\n"));
    }
  );
}
