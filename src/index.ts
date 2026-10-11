#!/usr/bin/env node
/**
 * arduino-mcp — MCP server for Arduino boards via arduino-cli.
 * Supports AVR (Uno/Mega/Nano), ESP32 (S2/S3/C3), ESP8266, RP2040, SAMD and
 * any other board arduino-cli knows.
 * https://github.com/biyusku/arduino-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "./lib/env.js";
import { stopAllChildren } from "./lib/exec.js";
import { serialBuffer } from "./serial-buffer.js";
import { registerBoardTools } from "./tools/board.js";
import { registerBuildTools } from "./tools/build.js";
import { registerDiagramTools } from "./tools/diagram.js";
import { registerIdeTools } from "./tools/ide.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerProjectTools } from "./tools/project.js";
import { registerSerialTools } from "./tools/serial.js";
import { registerSketchTools } from "./tools/sketch.js";

function createServer(): McpServer {
  const server = new McpServer({ name: "arduino-mcp", version: VERSION });
  registerBoardTools(server);
  registerSketchTools(server);
  registerBuildTools(server);
  registerSerialTools(server);
  registerLibraryTools(server);
  registerIdeTools(server);
  registerDiagramTools(server);
  registerProjectTools(server);
  return server;
}

let shuttingDown = false;

/**
 * Closes open serial ports so they are not left locked, stops running
 * arduino-cli/avrdude/esptool processes, then exits.
 */
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.race([
    Promise.all([serialBuffer.stopAll(), stopAllChildren()]),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  process.exit(code);
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  server.server.onclose = () => void shutdown(0);
  // The stdio transport does not notice when the client goes away; open serial
  // ports would otherwise keep this process (and the port) alive forever.
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGHUP", () => void shutdown(0));
  await server.connect(transport);
  console.error(`arduino-mcp v${VERSION} started`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
