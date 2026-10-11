import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cli } from "../lib/arduino.js";
import { assertLibraryName, assertPlatformId } from "../lib/validate.js";
import { DESTRUCTIVE, NETWORK, ok, READ_ONLY } from "./util.js";

/** Board manager URLs for cores that are not in Arduino's default index. */
export const EXTRA_INDEX_URLS: Record<string, string> = {
  "esp32:esp32": "https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json",
  "rp2040:rp2040": "https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json",
  "esp8266:esp8266": "https://arduino.esp8266.com/stable/package_esp8266com_index.json",
};

const status = (ok: boolean, yes: string, no: string) => `${ok ? "✅" : "❌"} ${ok ? yes : no}`;

export function registerLibraryTools(server: McpServer): void {
  server.registerTool(
    "install_library",
    {
      title: "Install library",
      description: "Installs an Arduino library from the library index, optionally a specific version.",
      inputSchema: {
        library: z.string().describe('Library name, e.g. "DHT sensor library"'),
        version: z.string().optional().describe("Version, e.g. 1.4.6"),
      },
      annotations: NETWORK,
    },
    async ({ library, version }) => {
      const name = assertLibraryName(library);
      const spec = version ? `${name}@${assertLibraryName(version)}` : name;
      const r = await cli(["lib", "install", "--", spec], 180_000);
      return ok(`${status(r.ok, `"${spec}" installed`, `"${spec}" could not be installed`)}:\n${r.output}`.trim());
    }
  );

  server.registerTool(
    "uninstall_library",
    {
      title: "Uninstall library",
      description: "Removes an installed Arduino library.",
      inputSchema: { library: z.string().describe("Library name") },
      annotations: DESTRUCTIVE,
    },
    async ({ library }) => {
      const name = assertLibraryName(library);
      const r = await cli(["lib", "uninstall", "--", name]);
      return ok(`${status(r.ok, `"${name}" removed`, `"${name}" could not be removed`)}:\n${r.output}`.trim());
    }
  );

  server.registerTool(
    "list_libraries",
    {
      title: "List installed libraries",
      description: "Lists installed Arduino libraries, optionally filtered by name.",
      inputSchema: { filter: z.string().optional().describe("Only show lines containing this text") },
      annotations: READ_ONLY,
    },
    async ({ filter }) => {
      const r = await cli(["lib", "list"]);
      if (!r.ok) return ok(`❌ ${r.output}`);
      let out = r.stdout;
      if (filter) {
        const [header, ...rows] = out.split("\n");
        out = [header, ...rows.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))].join("\n");
      }
      return ok(out || "No libraries installed.");
    }
  );

  server.registerTool(
    "search_library",
    {
      title: "Search libraries",
      description: "Searches the Arduino library index (first 50 lines of results).",
      inputSchema: { query: z.string().describe("Search terms") },
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ query }) => {
      const terms = query.split(/\s+/).filter(Boolean);
      const r = await cli(["lib", "search", "--", ...terms], 60_000);
      if (!r.ok) return ok(`❌ ${r.output}`);
      return ok(r.stdout.split("\n").slice(0, 50).join("\n") || "No results.");
    }
  );

  server.registerTool(
    "update_libraries",
    {
      title: "Update libraries",
      description: "Refreshes the library index and upgrades all installed libraries.",
      inputSchema: {},
      annotations: NETWORK,
    },
    async () => {
      const idx = await cli(["lib", "update-index"], 120_000);
      const r = await cli(["lib", "upgrade"], 300_000);
      return ok(`${status(r.ok, "Libraries updated", "Library update failed")}:\n${idx.ok ? "" : idx.output + "\n"}${r.output}`.trim());
    }
  );

  server.registerTool(
    "install_board",
    {
      title: "Install board platform",
      description:
        "Installs a board platform (core), e.g. arduino:avr, esp32:esp32, rp2040:rp2040, esp8266:esp8266. " +
        "Adds the board manager URL automatically for ESP32, ESP8266 and RP2040 (Earle Philhower core).",
      inputSchema: { platform: z.string().describe("Platform id, optionally with version: esp32:esp32 or arduino:avr@1.8.6") },
      annotations: NETWORK,
    },
    async ({ platform }) => {
      const id = assertPlatformId(platform);
      const url = EXTRA_INDEX_URLS[id.split("@")[0]];
      const notes: string[] = [];
      if (url) {
        // arduino-cli ignores URLs that are already configured
        const add = await cli(["config", "add", "board_manager.additional_urls", url]);
        if (!add.ok) notes.push(`Could not add board manager URL: ${add.output}`);
      }
      const idx = await cli(["core", "update-index"], 300_000);
      if (!idx.ok) notes.push(idx.output);
      const r = await cli(["core", "install", id], 900_000);
      return ok([status(r.ok, `${id} installed`, `${id} could not be installed`) + ":", ...notes, r.output].filter(Boolean).join("\n"));
    }
  );

  server.registerTool(
    "update_boards",
    {
      title: "Update board platforms",
      description: "Refreshes the board index and upgrades all installed platforms.",
      inputSchema: {},
      annotations: NETWORK,
    },
    async () => {
      const idx = await cli(["core", "update-index"], 300_000);
      const r = await cli(["core", "upgrade"], 900_000);
      return ok(`${status(r.ok, "Platforms updated", "Platform update failed")}:\n${idx.ok ? "" : idx.output + "\n"}${r.output}`.trim());
    }
  );

  server.registerTool(
    "list_installed_boards",
    {
      title: "List installed platforms",
      description: "Lists installed board platforms (cores).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const r = await cli(["core", "list"]);
      if (!r.ok) return ok(`❌ ${r.output}`);
      return ok(r.stdout || "No platforms installed.");
    }
  );
}
