import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cli, esptool, withExclusivePort } from "../lib/arduino.js";
import {
  applyBoardOptions, buildFqbn, cdcHint, getDefaultBoard, getPlatformFamily, isEspFamily, loadConfig, optionKey, setBoardOption,
  splitFqbn, updateConfig, type OptionField,
  type BoardConfig,
} from "../lib/config.js";
import { autoDetect, detectPorts, pickPorts, type DetectedPort } from "../lib/ports.js";
import { assertFqbn, assertSerialPort, parseBoardOptions, UserError } from "../lib/validate.js";
import { DESTRUCTIVE, fail, familyForPort, ok, READ_ONLY, reply, resolvePort, WRITES } from "./util.js";

/** Settings board_config can remove (clear) and the option field behind each. */
const CLEARABLE = ["upload_port", "monitor_port", "flash_size", "psram", "cdc_on_boot", "partition_scheme", "upload_speed",
  "extra_options"] as const;
const CLEAR_FIELDS: Record<"flash_size" | "psram" | "cdc_on_boot" | "partition_scheme" | "upload_speed", OptionField> = {
  flash_size: "flashSize",
  psram: "psram",
  cdc_on_boot: "cdcOnBoot",
  partition_scheme: "partitionScheme",
  upload_speed: "uploadSpeed",
};

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
        "Handles ESP32-S3 boards with two USB ports. Settings already saved for the same board are kept. " +
        "With several boards connected, pass port to choose the board.",
      inputSchema: {
        save: z.boolean().default(true).describe("Save as the default board"),
        port: z.string().optional().describe("With several boards connected: the port of the board to detect and save"),
      },
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ save, port }) => {
      const d = await autoDetect(port ? assertSerialPort(port) : undefined);
      if (!d && port) {
        throw new UserError(`No connected board on ${port}. list_boards shows the connected boards and their ports.`);
      }
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
      let saved: BoardConfig | null = null;
      if (save) {
        ({ fqbn, boardName, keptChoice, manualNote, saved } = await updateConfig((cfg) => {
          const key = d.serial || `unknown_${Date.now()}`;
          let prev: BoardConfig | undefined = cfg.boards[key];
          const candidates = [d.fqbn, ...d.alternatives.map((b) => b.fqbn)]
            .filter((f): f is string => !!f)
            .map((f) => splitFqbn(f).base);
          // A board set up by hand with board_config ("manual" entry):
          // - the detected board already has its own entry: that entry is used;
          // - a new board while "manual" is the default: "manual" becomes this
          //   board's entry if it fits (its FQBN is among the matches, or nothing
          //   matched), otherwise the detected board takes over as default;
          // - a new board while "manual" is not the default: never applied
          //   silently (it may be a different variant of the same board type),
          //   only suggested.
          // "manual" is never mixed into another board's entry automatically.
          const manual = cfg.boards.manual;
          const manualWasDefault = cfg.defaultBoard === "manual";
          const manualFqbn = manual ? buildFqbn(manual) : "";
          const fits = !!manual?.fqbn && (candidates.length === 0 || candidates.includes(manual.fqbn));
          let manualNote = "";
          if (manual?.fqbn && !prev && manualWasDefault && fits) {
            prev = manual;
            delete cfg.boards.manual;
            manualNote = `✅ Applied your manual setup (${manualFqbn}) to this board.`;
          } else if (manual?.fqbn && manualWasDefault) {
            manualNote = "⚠️ " + (prev
              ? `This board already has its own saved settings and is now the default board. `
              : `Your manual setup (${manualFqbn}) does not match the detected board, so the detected one is now the default. `) +
              "Your manual setup is kept; switch back with: board_config action=use id=manual";
          } else if (manual?.fqbn && !prev && fits) {
            manualNote = (candidates.length
              ? `💡 A saved manual setup (${manualFqbn}) is for this board type. If this is that board, `
              : `💡 The board type could not be identified. If this is the board of your manual setup (${manualFqbn}), `) +
              `apply it with: board_config action=set fqbn=${manualFqbn}`;
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
            nativeUsbMonitor: d.ports.find((p) => p.port === d.monitorPort)?.vendor === "303a" || undefined,
            lastSeen: new Date().toISOString(),
          };
          cfg.defaultBoard = key;
          return {
            fqbn: chosen, boardName: name, keptChoice: keepPrev && candidates.length > 0 && candidates[0] !== chosen, manualNote,
            saved: cfg.boards[key],
          };
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
      if (manualNote) lines.push(manualNote);
      const others = [d.fqbn, ...d.alternatives.map((b) => b.fqbn)].filter((f) => f && splitFqbn(f).base !== fqbn);
      if (others.length) {
        lines.push(`Also matches: ${others.join(", ")} (change with board_config if needed)`);
      }
      if (d.paired) {
        lines.push("(Two USB ports were combined as one dual-USB board. If they are two different boards, set the ports with board_config.)");
      }
      if (d.otherPorts.length) {
        lines.push("", "⚠️ Other boards are connected. To use one of them instead, run detect_board with its port:");
        lines.push(...d.otherPorts.map(describePort));
      }
      if (save) {
        lines.push("", "✅ Saved as default board.");
        const hint = cdcHint(saved, d.monitorPort);
        if (hint) lines.push(hint);
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
        "Shows or updates the saved default board, or switches the default to another saved board (action=use, id from show). " +
        "ESP32 options: flash_size, psram, cdc_on_boot, partition_scheme, upload_speed. " +
        "ESP8266: upload_speed. Any other board menu option (e.g. Nano's cpu=atmega328old) goes into extra_options. " +
        "Empty strings mean \"not given\"; to remove saved settings (back to the board default) pass clear, e.g. [\"psram\"]. " +
        "Use board_options to see what a board supports.",
      inputSchema: {
        action: z.enum(["show", "set", "use"]).default("show"),
        id: z.string().optional().describe("Saved board to make the default (action=use); IDs are listed by action=show"),
        fqbn: z.string().optional().describe("Board FQBN, e.g. arduino:avr:uno or esp32:esp32:esp32s3 (options after the 3rd ':' are kept)"),
        upload_port: z.string().optional().describe("Upload port, e.g. /dev/ttyACM1, /dev/cu.usbserial-110, COM4"),
        monitor_port: z.string().optional().describe("Serial monitor port"),
        flash_size: z.string().optional().describe("ESP32 FlashSize, e.g. 4M, 8M, 16M"),
        psram: z.string().optional().describe("ESP32 PSRAM, e.g. disabled, enabled, opi"),
        cdc_on_boot: z.string().optional().describe("ESP32-S2/S3/C3 CDCOnBoot: default (off) or cdc"),
        partition_scheme: z.string().optional().describe("ESP32 PartitionScheme, e.g. default, huge_app, min_spiffs, no_ota"),
        upload_speed: z.string().optional().describe("ESP32/ESP8266 upload baud, e.g. 921600, 460800, 115200"),
        extra_options: z.string().optional().describe("Other menu options as key=value,key2=value2 (replaces the previous value)"),
        clear: z.array(z.enum(CLEARABLE)).optional().describe("Saved settings to remove with action=set, e.g. [\"psram\", \"upload_port\"]"),
      },
      annotations: WRITES,
    },
    async (args) => {
      // Some clients send every optional field, empty when unused, so "" always
      // means "not given"; removing a setting is explicit (clear).
      const given = (v: string | undefined) => (v === "" ? undefined : v);
      const id = given(args.id);
      const a = {
        fqbn: given(args.fqbn), upload_port: given(args.upload_port), monitor_port: given(args.monitor_port),
        flash_size: given(args.flash_size), psram: given(args.psram), cdc_on_boot: given(args.cdc_on_boot),
        partition_scheme: given(args.partition_scheme), upload_speed: given(args.upload_speed), extra_options: given(args.extra_options),
      };
      const clear = new Set(args.clear ?? []);
      // Never silently ignore arguments: they would end up applied to (or
      // missing from) a different board than the caller meant.
      const settings = [...(Object.keys(a) as Array<keyof typeof a>).filter((k) => a[k] !== undefined), ...(clear.size ? ["clear"] : [])];
      const both = [...clear].filter((k) => a[k] !== undefined);
      if (both.length) throw new UserError(`${both.join(", ")} given and cleared in the same call; pass one or the other.`);
      if (id !== undefined && args.action !== "use") {
        throw new UserError(`id is only used with action=use. To work with board "${id}", select it first: board_config action=use id=${id}`);
      }
      if (settings.length && args.action !== "set") {
        throw new UserError(`action=${args.action} does not change settings (${settings.join(", ")}); use action=set${args.action === "use" ? " in a separate call" : ""}.`);
      }

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
          ...Object.entries(cfg.boards)
            .filter(([id]) => id !== cfg.defaultBoard)
            .map(([id, o], i) => `${i === 0 ? "Other saved:    " : "                "}${id}  ${buildFqbn(o) || "no FQBN"}  ${o.uploadPort || ""}`.trimEnd()),
        ].filter((l) => l !== null).join("\n"));
      }

      if (args.action === "use") {
        if (!id) throw new UserError('action=use needs id; the saved boards are listed by board_config action=show.');
        return updateConfig((cfg) => {
          const b = Object.hasOwn(cfg.boards, id) ? cfg.boards[id] : undefined;
          if (!b) throw new UserError(`No saved board "${id}". Saved: ${Object.keys(cfg.boards).join(", ") || "none"}.`);
          cfg.defaultBoard = id;
          return ok(`✅ Default board is now ${id}.\nFQBN: ${buildFqbn(b) || "not set"}\nUpload: ${b.uploadPort || "not set"} | Monitor: ${b.monitorPort || "not set"}`);
        });
      }

      return updateConfig((cfg) => {
        // Create a manual entry when nothing was detected yet.
        if (!getDefaultBoard(cfg)) {
          if (!a.fqbn) throw new UserError('No saved board yet. Run "detect_board", or pass fqbn to create one manually.');
          cfg.boards.manual = { fqbn: "", family: "unknown", uploadPort: "", monitorPort: "", lastSeen: new Date().toISOString() };
          cfg.defaultBoard = "manual";
        }
        const b = getDefaultBoard(cfg)!;

        const notes: string[] = [];
        // removals first, so values given in the same call (or inside the fqbn) win
        for (const k of clear) {
          if (k === "upload_port") b.uploadPort = "";
          else if (k === "monitor_port") b.monitorPort = "";
          else if (k === "extra_options") b.extraOptions = undefined;
          else if (!optionKey(b.family, CLEAR_FIELDS[k])) {
            notes.push(`⚠️ ${k} does not apply to ${b.family} boards, so nothing was cleared; their menu options are in ` +
              `extra_options (set extra_options again, or clear ["extra_options"]).`);
          } else setBoardOption(b, CLEAR_FIELDS[k], undefined);
        }
        if (a.fqbn) {
          const { base, options } = splitFqbn(assertFqbn(a.fqbn));
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
        if (a.upload_port) b.uploadPort = assertSerialPort(a.upload_port);
        if (a.monitor_port) b.monitorPort = assertSerialPort(a.monitor_port);
        if (a.extra_options) {
          parseBoardOptions(a.extra_options);
          b.extraOptions = undefined;
          applyBoardOptions(b, a.extra_options);
        }

        const fieldArgs: Array<[OptionField, string, string | undefined]> = [
          ["flashSize", "flash_size", a.flash_size],
          ["psram", "psram", a.psram],
          ["cdcOnBoot", "cdc_on_boot", a.cdc_on_boot],
          ["partitionScheme", "partition_scheme", a.partition_scheme],
          ["uploadSpeed", "upload_speed", a.upload_speed],
        ];
        for (const [field, argName, value] of fieldArgs) {
          if (value === undefined) continue;
          if (!optionKey(b.family, field)) {
            // Not stored: on load, uploadSpeed on AVR boards is read as v3's "cpu" setting.
            notes.push(`⚠️ ${argName} has no effect on ${b.family} boards and was not saved; use extra_options for their menu options.`);
            continue;
          }
          setBoardOption(b, field, optionValue(argName, value));
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
      const resolved = await resolvePort("upload", port);
      // judged by the board on that port, not by the saved board
      const { family } = await familyForPort(resolved, board);
      if (family !== "unknown" && !isEspFamily(family)) {
        throw new UserError(`erase_flash only works on ESP32/ESP8266 boards; the board on ${resolved} is "${family}".`);
      }
      const { result: r, notes } = await withExclusivePort(resolved, { alsoPause: [board?.monitorPort], freePort: free_port }, () =>
        esptool(["--port", resolved, "erase_flash"], 120_000)
      );
      return reply(r.ok, [`${r.ok ? "✅" : "❌"} Flash erase ${r.ok ? "completed" : "failed"}:`, r.output, ...notes].filter(Boolean).join("\n"));
    }
  );
}
