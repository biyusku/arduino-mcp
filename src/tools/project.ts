import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { cli } from "../lib/arduino.js";
import { displayPath } from "../lib/env.js";
import { assertBuildFlags, assertFqbn, assertLibraryName, assertSerialPort, sketchDir, UserError } from "../lib/validate.js";
import {
  CONFIG_FILENAME, listProjectFiles, readProjectConfig, readProjectFile, writeProjectConfig, writeProjectFile,
  type ArduinoProject,
} from "../project.js";
import { NETWORK, ok, READ_ONLY, reply, WRITES } from "./util.js";

const nameArg = z.string().describe("Sketch name");

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "project_init",
    {
      title: "Create project config",
      description:
        `Creates ${CONFIG_FILENAME} for a sketch: libraries, build flags, baud and, if given, a board (FQBN) and ports ` +
        "pinned to this sketch. compile/upload tools use them for this sketch (explicit tool arguments still win); " +
        "anything not pinned comes from the saved board, so detect_board/board_config changes keep applying.",
      inputSchema: {
        name: nameArg,
        description: z.string().optional().describe("Project description"),
        fqbn: z.string().optional().describe("Pin a board FQBN to this sketch (default: use the saved board)"),
        upload_port: z.string().optional().describe("Pin an upload port to this sketch (default: use the saved board)"),
        monitor_port: z.string().optional().describe("Pin a monitor port to this sketch (default: use the saved board)"),
        baud: z.number().int().positive().optional().describe("Serial baud rate (default 115200)"),
        libraries: z.array(z.string()).optional().describe('Required libraries, e.g. ["DHT sensor library", "FastLED"]'),
        build_flags: z.array(z.string()).optional().describe('Extra compiler flags, one per entry: -DNAME[=value], -UNAME, -O2, -g, -std=..., -W..., -f..., -m...'),
        overwrite: z.boolean().default(false).describe(`Replace an existing ${CONFIG_FILENAME}`),
      },
      annotations: WRITES,
    },
    async (args) => {
      const existingFile = path.join(sketchDir(args.name), CONFIG_FILENAME);
      if (!args.overwrite && fs.existsSync(existingFile)) {
        throw new UserError(`${displayPath(existingFile)} already exists. Use overwrite=true to replace it.`);
      }
      const project: ArduinoProject = {
        name: args.name,
        description: args.description || `Arduino project: ${args.name}`,
        version: "1.0.0",
        fqbn: args.fqbn ? assertFqbn(args.fqbn) : undefined,
        upload_port: args.upload_port ? assertSerialPort(args.upload_port) : undefined,
        monitor_port: args.monitor_port ? assertSerialPort(args.monitor_port) : undefined,
        baud: args.baud || 115200,
        libraries: (args.libraries || []).map(assertLibraryName),
        build_flags: assertBuildFlags(args.build_flags || []),
      };
      const file = await writeProjectConfig(args.name, project);
      return ok([
        `✅ Project config created: ${displayPath(file)}`,
        `FQBN:     ${project.fqbn || "saved board"}`,
        `Upload:   ${project.upload_port || "saved board"}`,
        `Monitor:  ${project.monitor_port || "saved board"}`,
        `Baud:     ${project.baud}`,
        project.libraries?.length ? `Libs:     ${project.libraries.join(", ")}` : "",
        project.build_flags?.length ? `Flags:    ${project.build_flags.join(" ")}` : "",
      ].filter(Boolean).join("\n"));
    }
  );

  server.registerTool(
    "project_info",
    {
      title: "Show project config",
      description: `Shows a sketch's ${CONFIG_FILENAME} and its source files.`,
      inputSchema: { name: nameArg },
      annotations: READ_ONLY,
    },
    async ({ name }) => {
      const project = await readProjectConfig(name);
      if (!project) throw new UserError(`${name}/${CONFIG_FILENAME} not found. Create it with project_init.`);
      const files = await listProjectFiles(name);
      return ok([
        `📦 Project: ${project.name}`,
        project.description ? `Description: ${project.description}` : "",
        project.version ? `Version:  ${project.version}` : "",
        ...(project.legacy
          ? ["FQBN/ports: saved board is used (this file was written by arduino-mcp v3, whose copies of the board",
             "            settings are ignored; recreate it with project_init overwrite=true to pin a board)"]
          : [
            `FQBN:     ${project.fqbn || "not set (saved board is used)"}`,
            `Upload:   ${project.upload_port || "not set (saved board is used)"}`,
            `Monitor:  ${project.monitor_port || "not set (saved board is used)"}`,
          ]),
        `Baud:     ${project.baud || 115200}`,
        project.libraries?.length ? `Libs:     ${project.libraries.join(", ")}` : "",
        project.build_flags?.length ? `Flags:    ${project.build_flags.join(" ")}` : "",
        `Files:    ${files.join(", ") || "none"}`,
      ].filter(Boolean).join("\n"));
    }
  );

  server.registerTool(
    "project_list_files",
    {
      title: "List project files",
      description: "Lists source files of a sketch (.ino, .h, .hpp, .c, .cpp, .S), including the src/ subfolder.",
      inputSchema: { name: nameArg },
      annotations: READ_ONLY,
    },
    async ({ name }) => {
      const files = await listProjectFiles(name);
      if (files.length === 0) throw new UserError(`Sketch "${name}" not found or has no source files.`);
      return ok(`📂 ${displayPath(sketchDir(name))}/\n${files.map((f) => `  • ${f}`).join("\n")}`);
    }
  );

  server.registerTool(
    "project_read_file",
    {
      title: "Read project file",
      description: "Reads a file inside a sketch folder (e.g. sensors.h, src/utils.cpp).",
      inputSchema: {
        name: nameArg,
        filename: z.string().describe("Path relative to the sketch folder, e.g. sensors.h or src/utils.cpp"),
      },
      annotations: READ_ONLY,
    },
    async ({ name, filename }) => {
      const content = await readProjectFile(name, filename);
      if (content === null) throw new UserError(`${name}/${filename} not found.`);
      const ext = path.extname(filename).slice(1) || "text";
      return ok(`📄 ${filename}:\n\`\`\`${ext}\n${content}\n\`\`\``);
    }
  );

  server.registerTool(
    "project_write_file",
    {
      title: "Write project file",
      description: "Creates or replaces a file inside a sketch folder (headers, .cpp/.c sources, src/ subfolders).",
      inputSchema: {
        name: nameArg,
        filename: z.string().describe("Path relative to the sketch folder, e.g. sensors.h or src/utils.cpp"),
        content: z.string().describe("File content"),
      },
      annotations: WRITES,
    },
    async ({ name, filename, content }) => {
      const file = await writeProjectFile(name, filename, content);
      return ok(`✅ ${displayPath(file)} written.`);
    }
  );

  server.registerTool(
    "project_install_deps",
    {
      title: "Install project libraries",
      description: `Installs all libraries listed in a sketch's ${CONFIG_FILENAME}.`,
      inputSchema: { name: nameArg },
      annotations: NETWORK,
    },
    async ({ name }) => {
      const project = await readProjectConfig(name);
      if (!project) throw new UserError(`${name}/${CONFIG_FILENAME} not found.`);
      if (!project.libraries?.length) return ok("ℹ️ This project lists no libraries.");
      const results: string[] = [];
      let allOk = true;
      for (const lib of project.libraries) {
        const r = await cli(["lib", "install", "--", assertLibraryName(lib)], 180_000);
        allOk &&= r.ok;
        results.push(`${r.ok ? "✅" : "❌"} ${lib}: ${r.ok ? "installed" : r.output.split("\n").pop()}`);
      }
      return reply(allOk, results.join("\n"));
    }
  );
}
