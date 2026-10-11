import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDefaultBoard, loadConfig, resetsOnOpen } from "../lib/config.js";
import { assertPortAccessible, detectPorts } from "../lib/ports.js";
import { serialBuffer } from "../serial-buffer.js";
import { fail, ok, READ_ONLY, reply, resolvePort, WRITES } from "./util.js";

const portArg = z.string().optional().describe("Serial port (default: saved monitor port, then auto-detect)");
const baudArg = z.number().int().positive().default(115200).describe("Baud rate");

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
        baud: baudArg,
        seconds: z.number().min(1).max(60).default(5).describe("How long to read (1-60 s)"),
      },
      annotations: READ_ONLY,
    },
    async ({ port, baud, seconds }) => {
      const resolved = await resolvePort("monitor", port);
      if (!serialBuffer.isRunning(resolved)) await assertPortAccessible(resolved);
      const lines = await serialBuffer.readFor(resolved, baud, seconds * 1000);
      return ok(lines.length
        ? `📡 ${resolved} @ ${baud} (${seconds}s):\n${lines.join("\n")}`
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
        baud: baudArg,
        newline: z.boolean().default(true).describe("Append a newline (\\n)"),
        read_response: z.boolean().default(true).describe("Wait for and return the reply"),
        response_seconds: z.number().min(0).max(30).default(2).describe("How long to wait for a reply"),
        wait_after_open_ms: z.number().int().min(0).max(10_000).optional()
          .describe("Wait after opening the port before sending (default: 2000 for AVR boards, else 0)"),
      },
      annotations: WRITES,
    },
    async ({ message, port, baud, newline, read_response, response_seconds, wait_after_open_ms }) => {
      const resolved = await resolvePort("monitor", port);
      if (!serialBuffer.isRunning(resolved)) await assertPortAccessible(resolved);
      const board = getDefaultBoard(await loadConfig());
      const openDelay = wait_after_open_ms ?? (resetsOnOpen(board?.family) ? 2000 : 0);
      const data = newline ? `${message}\n` : message;
      const reply = await serialBuffer.send(resolved, baud, data, read_response ? response_seconds * 1000 : 0, openDelay);
      if (!read_response) return ok(`📤 Sent: "${message}"`);
      return ok(`📤 Sent: "${message}"\n📥 Reply:\n${reply.length ? reply.join("\n") : "(no reply)"}`);
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
      inputSchema: { port: portArg, baud: baudArg },
      annotations: WRITES,
    },
    async ({ port, baud }) => {
      const resolved = await resolvePort("monitor", port);
      if (!serialBuffer.isRunning(resolved)) await assertPortAccessible(resolved);
      return ok(`✅ ${await serialBuffer.start(resolved, baud)}`);
    }
  );

  server.registerTool(
    "serial_read",
    {
      title: "Read background serial buffer",
      description: "Returns the last N lines from a background serial session started with serial_start.",
      inputSchema: {
        port: portArg,
        lines: z.number().int().min(1).max(500).default(50).describe("Number of lines (1-500)"),
        clear: z.boolean().default(false).describe("Clear the buffer after reading"),
      },
      annotations: READ_ONLY,
    },
    async ({ port, lines, clear }) => {
      const resolved = await resolvePort("monitor", port);
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
