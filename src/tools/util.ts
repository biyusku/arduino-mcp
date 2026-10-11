import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getDefaultBoard, getPlatformFamily, loadConfig, type BoardConfig } from "../lib/config.js";
import { autoDetect, detectPorts, type DetectedPort } from "../lib/ports.js";
import { assertSerialPort, UserError } from "../lib/validate.js";

export function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** ok() or fail(), so clients that branch on isError see failed builds/uploads as failures. */
export function reply(success: boolean, text: string): CallToolResult {
  return success ? ok(text) : fail(text);
}

/** Tool annotation presets (hints for MCP clients, e.g. to ask before destructive calls). */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
export const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
export const NETWORK = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

/**
 * Port for a tool call: explicit argument > saved default board > auto-detect.
 */
export async function resolvePort(kind: "upload" | "monitor", explicit?: string): Promise<string> {
  if (explicit) return assertSerialPort(explicit);
  const board = getDefaultBoard(await loadConfig());
  const saved = kind === "upload" ? board?.uploadPort : board?.monitorPort;
  if (saved) return assertSerialPort(saved);
  const detected = await autoDetect();
  const port = kind === "upload" ? detected?.uploadPort : detected?.monitorPort;
  if (port) return assertSerialPort(port);
  throw new UserError('No serial port found. Plug in the board and run "detect_board", or pass port.');
}

/**
 * The board family on a port: the saved board's for its own ports, otherwise
 * what arduino-cli matched there ("unknown" if nothing). Tools must not
 * apply the saved board's family to a port of another board.
 */
export async function familyForPort(
  port: string,
  board: BoardConfig | null,
  ports?: DetectedPort[]
): Promise<{ family: string; info?: DetectedPort }> {
  if (board?.fqbn && (port === board.uploadPort || port === board.monitorPort)) return { family: board.family };
  const info = (ports ?? (await detectPorts())).find((p) => p.port === port);
  if (info?.boards.length) return { family: getPlatformFamily(info.boards[0].fqbn), info };
  if (info?.vendor === "303a") return { family: "esp32", info };
  return { family: "unknown", info };
}

