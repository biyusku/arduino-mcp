import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { cli } from "../lib/arduino.js";
import { commandExists, naturalCompare } from "../lib/exec.js";
import { assertHttpUrl, sketchDir, UserError } from "../lib/validate.js";
import { DESTRUCTIVE, ok, READ_ONLY, reply, WRITES } from "./util.js";

interface IdeCommand {
  cmd: string;
  args: string[];
}

/** The matching file with the highest version number (2.3.10 > 2.3.9). */
export function newestMatch(dir: string, re: RegExp): string | null {
  try {
    const hits = fs.readdirSync(dir).filter((f) => re.test(f)).sort(naturalCompare);
    return hits.length ? path.join(dir, hits[hits.length - 1]) : null;
  } catch {
    return null;
  }
}

/** Finds Arduino IDE 2: $ARDUINO_IDE_PATH, then the usual install locations per OS. */
export function findIde(): IdeCommand | null {
  const fromEnv = process.env.ARDUINO_IDE_PATH;
  if (fromEnv) {
    if (process.platform === "darwin" && fromEnv.endsWith(".app")) return { cmd: "open", args: ["-a", fromEnv] };
    // AppImages need --no-sandbox on distros where Electron's sandbox helper is not setuid.
    return { cmd: fromEnv, args: fromEnv.endsWith(".AppImage") ? ["--no-sandbox"] : [] };
  }
  if (process.platform === "darwin") {
    return fs.existsSync("/Applications/Arduino IDE.app") ? { cmd: "open", args: ["-a", "Arduino IDE"] } : null;
  }
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Arduino IDE", "Arduino IDE.exe"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Arduino IDE", "Arduino IDE.exe"),
    ];
    const hit = candidates.find((c) => fs.existsSync(c));
    return hit ? { cmd: hit, args: [] } : null;
  }
  for (const dir of [path.join(os.homedir(), "Applications"), path.join(os.homedir(), "Downloads"), "/opt"]) {
    const appImage = newestMatch(dir, /^arduino-ide.*\.AppImage$/i);
    if (appImage) return { cmd: appImage, args: ["--no-sandbox"] };
  }
  if (fs.existsSync("/opt/arduino-ide/arduino-ide")) return { cmd: "/opt/arduino-ide/arduino-ide", args: [] };
  if (commandExists("arduino-ide")) return { cmd: "arduino-ide", args: [] };
  return null;
}

/** Starts a GUI program detached from this server; resolves once it has started. */
function launchDetached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", (e) => reject(new UserError(`Could not start ${cmd}: ${e.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const INSTALL_HELP: Record<string, string> = {
  darwin: "  brew install arduino-cli",
  win32: "  winget install ArduinoSA.CLI",
  linux: "  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=~/.local/bin sh",
};

export function registerIdeTools(server: McpServer): void {
  server.registerTool(
    "open_arduino_ide",
    {
      title: "Open Arduino IDE",
      description: "Opens Arduino IDE 2, optionally with a sketch. Set ARDUINO_IDE_PATH if the IDE is not found.",
      inputSchema: { sketch: z.string().optional().describe("Sketch to open") },
      annotations: { ...WRITES, openWorldHint: true },
    },
    async ({ sketch }) => {
      const ide = findIde();
      if (!ide) {
        throw new UserError("Arduino IDE not found. Install it from https://www.arduino.cc/en/software or set ARDUINO_IDE_PATH.");
      }
      const args = [...ide.args];
      if (sketch) {
        const file = path.join(sketchDir(sketch), `${sketch}.ino`);
        if (!fs.existsSync(file)) throw new UserError(`Sketch not found: ${file}`);
        args.push(file);
      }
      await launchDetached(ide.cmd, args);
      return ok(sketch ? `✅ Opening Arduino IDE with ${sketch}` : "✅ Opening Arduino IDE...");
    }
  );

  server.registerTool(
    "arduino_cli_check",
    {
      title: "Check arduino-cli",
      description: "Checks whether arduino-cli is installed and shows its version (or how to install it).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const r = await cli(["version"]);
      if (r.ok) return ok(`✅ arduino-cli is installed:\n${r.stdout}`);
      return ok([
        "❌ arduino-cli not found (or ARDUINO_CLI_PATH is wrong).",
        "Install:",
        INSTALL_HELP[process.platform] || INSTALL_HELP.linux,
        "Docs: https://arduino.github.io/arduino-cli/latest/installation/",
      ].join("\n"));
    }
  );

  server.registerTool(
    "arduino_cli_config",
    {
      title: "arduino-cli configuration",
      description:
        "Shows the arduino-cli configuration, adds a board manager URL, or resets the configuration to defaults " +
        "(reset needs confirm=true and removes all custom settings such as board manager URLs).",
      inputSchema: {
        action: z.enum(["show", "add_url", "reset"]).default("show"),
        url: z.string().optional().describe("Board manager URL (for add_url)"),
        confirm: z.boolean().default(false).describe("Must be true for reset"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, url, confirm }) => {
      if (action === "show") {
        const r = await cli(["config", "dump"]);
        return reply(r.ok, r.output);
      }
      if (action === "add_url") {
        if (!url) throw new UserError("add_url needs the url parameter.");
        const r = await cli(["config", "add", "board_manager.additional_urls", assertHttpUrl(url)]);
        return reply(r.ok, r.ok ? `✅ URL added: ${url}` : `❌ Could not add URL:\n${r.output}`);
      }
      if (!confirm) {
        throw new UserError("reset overwrites the arduino-cli configuration (board manager URLs etc.). Call again with confirm=true to proceed.");
      }
      const r = await cli(["config", "init", "--overwrite"]);
      return reply(r.ok, r.ok ? `✅ arduino-cli configuration reset.\n${r.output}` : `❌ Reset failed:\n${r.output}`);
    }
  );
}
