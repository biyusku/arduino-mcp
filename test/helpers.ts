import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_CLI = path.join(ROOT, "test", "fixtures", "fake-arduino-cli.cjs");
export const SERVER_ARGS = ["--import", "tsx", path.join(ROOT, "src", "index.ts")];

export interface Sandbox {
  /** test/fixtures/fake-arduino-cli.cjs prints <dir>/board-list.json for "board list" */
  dir: string;
  home: string;
  sketches: string;
  cliLog: string;
  env: Record<string, string>;
}

/** Isolated HOME, sketches folder and config for one server instance. */
export function makeSandbox(cli = FAKE_CLI): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amcp-e2e-"));
  const home = path.join(dir, "home");
  const sketches = path.join(home, "Arduino");
  fs.mkdirSync(sketches, { recursive: true });
  const cliLog = path.join(dir, "cli.log");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    ARDUINO_SKETCHES_DIR: sketches,
    ARDUINO_MCP_CONFIG: path.join(home, ".arduino-mcp.json"),
    ARDUINO_CLI_PATH: cli,
    FAKE_CLI_LOG: cliLog,
    FAKE_BOARD_LIST_FILE: path.join(dir, "board-list.json"),
    ESPTOOL_PATH: cli, // logs its arguments like arduino-cli
  });
  return { dir, home, sketches, cliLog, env };
}

export function cliCalls(sb: Sandbox): string[][] {
  if (!fs.existsSync(sb.cliLog)) return [];
  return fs.readFileSync(sb.cliLog, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export async function connect(sb: Sandbox) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: SERVER_ARGS,
    cwd: ROOT,
    env: sb.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "arduino-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text?: string }>;
    return { text: content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
  };
  return { client, call, close: () => client.close() };
}

/** Starts the fake serial board (Linux/macOS, needs python3); resolves with its tty path. */
export function startFakeBoard(opts: { silent?: boolean } = {}): Promise<{ port: string; proc: ChildProcessWithoutNullStreams }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [path.join(ROOT, "test", "fixtures", "fakeboard.py"), ...(opts.silent ? ["--silent"] : [])]);
    proc.once("error", reject);
    proc.stdout.once("data", (d: Buffer) => resolve({ port: d.toString().trim().split("\n")[0], proc }));
  });
}
