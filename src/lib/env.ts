import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const ARDUINO_CLI = process.env.ARDUINO_CLI_PATH || "arduino-cli";
export const SKETCHES_DIR = process.env.ARDUINO_SKETCHES_DIR || path.join(os.homedir(), "Arduino");
export const CONFIG_FILE = process.env.ARDUINO_MCP_CONFIG || path.join(os.homedir(), ".arduino-mcp.json");

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Shortens paths under the home directory to "~/..." for display. */
export function displayPath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}
