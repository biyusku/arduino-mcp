import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getDefaultBoard, loadConfig } from "../lib/config.js";
import { autoDetect } from "../lib/ports.js";
import { assertSerialPort, UserError } from "../lib/validate.js";

export function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
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
