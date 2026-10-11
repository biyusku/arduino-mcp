import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDefaultBoard, loadConfig, resetsOnOpen, type BoardConfig } from "../lib/config.js";
import { assertPortAccessible, detectPorts, portPresenceChecker } from "../lib/ports.js";
import { CONFIG_FILENAME, readProjectConfig } from "../project.js";
import { assertSerialPort, UserError } from "../lib/validate.js";
import { serialBuffer } from "../serial-buffer.js";
import { fail, familyForPort, ok, READ_ONLY, reply, resolvePort, WRITES } from "./util.js";

const portArg = z.string().optional().describe("Serial port (default: the sketch's pinned monitor port, saved monitor port, then auto-detect)");
const sketchArg = z.string().optional().describe("Sketch whose arduino-mcp.yaml provides the monitor port and baud rate");

/**
 * Port and baud for a serial call: explicit arguments, then the sketch's
 * arduino-mcp.yaml (monitor_port, baud), then the saved board / auto-detect.
 */
async function serialTarget(port: string | undefined, baud: number | undefined, sketch: string | undefined) {
  if (sketch) {
    const project = await readProjectConfig(sketch);
    if (!project) throw new UserError(`${sketch}/${CONFIG_FILENAME} not found. Create it with project_init.`);
    const pinned = project.legacy ? undefined : project.monitor_port; // v3 files: copies, never used
    if (!port && pinned) {
      if (!(await portPresenceChecker())(pinned)) {
        throw new UserError(`${CONFIG_FILENAME} pins monitor port ${pinned} for this sketch, but it is not connected. Connect that board or pass port.`);
      }
      port = pinned;
    }
    baud ??= project.baud;
  }
  return { port: await resolvePort("monitor", port), baud };
}
const optionalBaudArg = z.number().int().positive().optional()
  .describe("Baud rate (default: the running background session's, else 115200)");

// USB-serial bridges of boards that reset when the port is opened (DTR):
// Uno/Mega (16U2), and the CH340/FTDI chips on Nano/Pro Mini clones.
const AUTO_RESET_VENDORS = new Set(["2341", "2a03", "1a86", "0403"]);

/** How long to wait after opening a port before sending: boards that reset on open need to boot first. */
async function resetDelayFor(port: string, board: BoardConfig | null): Promise<number> {
  const { family, info } = await familyForPort(port, board);
  if (family !== "unknown") return resetsOnOpen(family) ? 2000 : 0;
  const ch343 = info?.vendor === "1a86" && info.product === "55d3"; // ESP32-S3 dual-USB bridge, no DTR reset
  return info && AUTO_RESET_VENDORS.has(info.vendor) && !ch343 ? 2000 : 0;
}

/**
 * A running background session fixes the baud rate; asking for another one
 * is an error instead of silently reading at the session's rate.
 */
function effectiveBaud(port: string, requested: number | undefined): number {
  const running = serialBuffer.sessionBaud(port);
  if (running === undefined) return requested ?? 115200;
  if (requested !== undefined && requested !== running) {
    throw new UserError(
      `A background session is running on ${port} at ${running} baud. ` +
      `Stop it with serial_stop, or restart it with serial_start baud=${requested}.`
    );
  }
  return running;
}

/** serial_read without a port: the only running session, or the saved monitor port's. */
async function defaultSessionPort(): Promise<string> {
  const sessions = serialBuffer.status();
  if (sessions.length === 1) return sessions[0].port;
  if (sessions.length === 0) throw new UserError("No background serial session is running. Start one with serial_start.");
  const saved = getDefaultBoard(await loadConfig())?.monitorPort;
  if (saved && sessions.some((s) => s.port === saved)) return saved;
  throw new UserError(`Several background sessions are running (${sessions.map((s) => s.port).join(", ")}); pass port.`);
}

export function registerSerialTools(server: McpServer): void {
  server.registerTool(
    "serial_monitor",
    {
      title: "Read serial output",
      description:
        "Reads serial output for a few seconds. If a background session (serial_start) is running on the port, " +
        "returns the lines that arrive during that time instead of opening the port again.",
      inputSchema: {
        port: portArg,
        baud: optionalBaudArg,
        sketch: sketchArg,
        seconds: z.number().min(1).max(60).default(5).describe("How long to read (1-60 s)"),
      },
      annotations: READ_ONLY,
    },
    async ({ port, baud, sketch, seconds }) => {
      const target = await serialTarget(port, baud, sketch);
      const resolved = target.port;
      const effective = effectiveBaud(resolved, target.baud);
      if (!serialBuffer.isRunning(resolved)) await assertPortAccessible(resolved);
      const lines = await serialBuffer.readFor(resolved, effective, seconds * 1000);
      return ok(lines.length
        ? `📡 ${resolved} @ ${effective} (${seconds}s):\n${lines.join("\n")}`
        : `📡 ${resolved}: no data received in ${seconds}s.`);
    }
  );

  server.registerTool(
    "send_serial",
    {
      title: "Send to serial",
      description:
        "Sends a message/command to the board over serial and returns the reply. Uses the background session if one is " +
        "running (no re-open, no reset). Otherwise opens the port; boards that reset on open (Uno, Nano, Mega) get time " +
        "to boot before the message is sent.",
      inputSchema: {
        message: z.string().describe("Text to send"),
        port: portArg,
        baud: optionalBaudArg,
        sketch: sketchArg,
        newline: z.boolean().default(true).describe("Append a newline (\\n)"),
        read_response: z.boolean().default(true).describe("Wait for and return the reply"),
        response_seconds: z.number().min(0).max(30).default(2).describe("How long to wait for a reply"),
        wait_after_open_ms: z.number().int().min(0).max(10_000).optional()
          .describe("Wait after opening the port before sending (default: 2000 for AVR boards, else 0)"),
      },
      annotations: WRITES,
    },
    async ({ message, port, baud, sketch, newline, read_response, response_seconds, wait_after_open_ms }) => {
      const target = await serialTarget(port, baud, sketch);
      const resolved = target.port;
      const effective = effectiveBaud(resolved, target.baud);
      if (!serialBuffer.isRunning(resolved)) await assertPortAccessible(resolved);
      const board = getDefaultBoard(await loadConfig());
      const openDelay = wait_after_open_ms ??
        (serialBuffer.isRunning(resolved) ? 0 : await resetDelayFor(resolved, board));
      const data = newline ? `${message}\n` : message;
      const answer = await serialBuffer.send(resolved, effective, data, read_response ? response_seconds * 1000 : 0, openDelay);
      if (!read_response) return ok(`📤 Sent: "${message}"`);
      return ok(`📤 Sent: "${message}"\n📥 Reply:\n${answer.length ? answer.join("\n") : "(no reply)"}`);
    }
  );

  server.registerTool(
    "get_serial_ports",
    {
      title: "List serial ports",
      description: "Lists USB serial ports with vendor/product IDs, serial number and upload/monitor role.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const ports = await detectPorts();
      if (ports.length === 0) return ok("No USB serial ports connected.");
      return ok(ports.map((p) => [
        `Port:      ${p.port}`,
        `Role:      ${p.role === "upload" ? "upload only" : p.role === "monitor" ? "monitor only" : "upload + monitor"}`,
        `Device:    ${p.description || "unknown"}`,
        `USB ID:    ${p.vendor}:${p.product}`,
        `Serial no: ${p.serial || "unknown"}`,
        p.boards.length ? `Boards:    ${p.boards.map((b) => b.fqbn).join(", ")}` : null,
        "─".repeat(44),
      ].filter((l) => l !== null).join("\n")).join("\n"));
    }
  );

  server.registerTool(
    "serial_start",
    {
      title: "Start background serial session",
      description:
        "Keeps the serial port open in the background and buffers its output (last 500 lines). Read it any time with " +
        "serial_read; send_serial and serial_monitor reuse the session. Uploads pause and resume it automatically.",
      inputSchema: {
        port: portArg,
        baud: z.number().int().positive().optional().describe("Baud rate (default: the sketch's baud, else 115200)"),
        sketch: sketchArg,
      },
      annotations: WRITES,
    },
    async ({ port, baud, sketch }) => {
      const target = await serialTarget(port, baud, sketch);
      if (!serialBuffer.isRunning(target.port)) await assertPortAccessible(target.port);
      return ok(`✅ ${await serialBuffer.start(target.port, target.baud ?? 115200)}`);
    }
  );

  server.registerTool(
    "serial_read",
    {
      title: "Read background serial buffer",
      description: "Returns the last N lines from a background serial session started with serial_start.",
      inputSchema: {
        port: z.string().optional().describe("Port of the session (default: the only running session, else the saved monitor port's)"),
        lines: z.number().int().min(1).max(500).default(50).describe("Number of lines (1-500)"),
        clear: z.boolean().default(false).describe("Clear the buffer after reading"),
      },
      annotations: READ_ONLY,
    },
    async ({ port, lines, clear }) => {
      const resolved = port ? assertSerialPort(port) : await defaultSessionPort();
      const result = serialBuffer.read(resolved, lines, clear);
      if (result === null) return fail(`❌ No background session on ${resolved}. Start one with serial_start.`);
      if (result.length === 0) return ok(`📡 ${resolved}: buffer is empty (no data yet).`);
      return ok(`📡 ${resolved} — last ${result.length} lines:\n${result.join("\n")}`);
    }
  );

  server.registerTool(
    "serial_stop",
    {
      title: "Stop background serial session",
      description: "Stops a background serial session (or all of them if no port is given).",
      inputSchema: { port: z.string().optional().describe("Port (leave empty to stop all sessions)") },
      annotations: WRITES,
    },
    async ({ port }) => {
      if (!port) {
        await serialBuffer.stopAll();
        return ok("✅ All background serial sessions stopped.");
      }
      const stopped = await serialBuffer.stop(port);
      return reply(stopped, stopped ? `✅ Stopped session on ${port}.` : `❌ No session on ${port}.`);
    }
  );

  server.registerTool(
    "serial_status",
    {
      title: "Background serial sessions",
      description: "Lists active background serial sessions (port, baud, buffered lines, bytes, uptime).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const sessions = serialBuffer.status();
      if (sessions.length === 0) return ok("📡 No active background serial sessions.");
      return ok("📡 Active sessions:\n" + sessions.map((s) =>
        `${s.port}  @ ${s.baud} baud  |  ${s.lineCount} lines  |  ${s.byteCount} bytes  |  uptime: ${s.uptime}`
      ).join("\n"));
    }
  );
}
