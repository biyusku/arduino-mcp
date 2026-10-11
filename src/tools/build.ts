import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cli, compile, resolveTarget, upload } from "../lib/arduino.js";
import { assertHost, UserError } from "../lib/validate.js";
import { reply, WRITES } from "./util.js";

const nameArg = z.string().describe("Sketch name");
const fqbnArg = z.string().optional().describe("Board FQBN (default: sketch's arduino-mcp.yaml, then the saved board)");
const portArg = z.string().optional().describe("Upload port (default: sketch's arduino-mcp.yaml, then the saved board)");
const freePortArg = z.boolean().default(true).describe("Stop other programs that keep the port open (they are listed in the result)");

export function registerBuildTools(server: McpServer): void {
  server.registerTool(
    "compile_sketch",
    {
      title: "Compile sketch",
      description:
        "Compiles a sketch. Board and build flags come from the sketch's arduino-mcp.yaml or the saved board unless fqbn is given. " +
        "Errors are listed as file:line:col.",
      inputSchema: {
        name: nameArg,
        fqbn: fqbnArg,
        verbose: z.boolean().default(false).describe("Verbose compiler output"),
      },
      annotations: { ...WRITES, idempotentHint: true },
    },
    async ({ name, fqbn, verbose }) => {
      const target = await resolveTarget(name, { fqbn });
      const result = await compile(target, verbose);
      return reply(result.ok, result.text);
    }
  );

  server.registerTool(
    "upload_sketch",
    {
      title: "Upload sketch",
      description:
        "Uploads the last compiled build of a sketch without compiling again. Serial sessions started with serial_start " +
        "are paused during the upload and resumed afterwards.",
      inputSchema: { name: nameArg, fqbn: fqbnArg, port: portArg, free_port: freePortArg },
      annotations: WRITES,
    },
    async ({ name, fqbn, port, free_port }) => {
      const target = await resolveTarget(name, { fqbn, port });
      const result = await upload(target, free_port);
      return reply(result.ok, result.text);
    }
  );

  server.registerTool(
    "compile_and_upload",
    {
      title: "Compile and upload",
      description:
        "Compiles a sketch and uploads it to the board in one step. Works for all board types. " +
        "Serial sessions are paused during the upload and resumed afterwards.",
      inputSchema: { name: nameArg, fqbn: fqbnArg, port: portArg, free_port: freePortArg },
      annotations: WRITES,
    },
    async ({ name, fqbn, port, free_port }) => {
      const target = await resolveTarget(name, { fqbn, port });
      if (!target.uploadPort) {
        throw new UserError('No upload port known. Run "detect_board", set one with "board_config", or pass port.');
      }
      const compiled = await compile(target);
      if (!compiled.ok) return reply(false, compiled.text);
      const uploaded = await upload(target, free_port);
      return reply(uploaded.ok, `${compiled.text}\n${uploaded.text}`);
    }
  );

  server.registerTool(
    "wifi_upload",
    {
      title: "Upload over WiFi (OTA)",
      description:
        "Compiles a sketch and uploads it over the network (OTA). The running sketch must already include ArduinoOTA " +
        "(ESP32/ESP8266) and be reachable on the same network; arduino-cli finds the board via mDNS.",
      inputSchema: {
        name: nameArg,
        ip: z.string().describe("Board IP address or host name"),
        fqbn: fqbnArg,
        password: z.string().optional().describe("OTA password, if the sketch sets one"),
      },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async ({ name, ip, fqbn, password }) => {
      const host = assertHost(ip);
      const target = await resolveTarget(name, { fqbn });
      const compiled = await compile(target);
      if (!compiled.ok) return reply(false, compiled.text);

      const args = ["upload", "--port", host, "--protocol", "network", "--fqbn", target.fqbn];
      if (password) args.push("--upload-field", `password=${password}`);
      args.push(target.dir);
      const r = await cli(args, 180_000);
      return reply(r.ok, [
        compiled.text,
        `${r.ok ? "✅" : "❌"} OTA upload ${r.ok ? "succeeded" : "failed"} → ${host}`,
        r.ok ? "" : r.output,
      ].filter(Boolean).join("\n"));
    }
  );
}
