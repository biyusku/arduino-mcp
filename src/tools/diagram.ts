import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  componentsFromConnections, generateMarkdownTable, generateSvg, parseConnections, type CircuitDiagram,
} from "../diagram.js";
import { displayPath } from "../lib/env.js";
import { sketchDir, UserError } from "../lib/validate.js";
import { ok, WRITES } from "./util.js";

const formatArg = z.enum(["svg", "markdown", "both"]);

/** Renders a diagram, optionally saving wiring.svg / wiring.md into a sketch folder. */
async function renderDiagram(diagram: CircuitDiagram, format: "svg" | "markdown" | "both", saveTo?: string): Promise<string> {
  const dir = saveTo ? sketchDir(saveTo) : null;
  if (dir) await fs.mkdir(dir, { recursive: true });
  const out: string[] = [];

  if (format === "svg" || format === "both") {
    const svg = generateSvg(diagram);
    if (dir) {
      const file = path.join(dir, "wiring.svg");
      await fs.writeFile(file, svg, "utf-8");
      out.push(`✅ SVG saved: ${displayPath(file)}`);
    } else {
      out.push("```svg", svg, "```");
    }
  }
  if (format === "markdown" || format === "both") {
    const md = generateMarkdownTable(diagram);
    if (dir) {
      const file = path.join(dir, "wiring.md");
      await fs.writeFile(file, md, "utf-8");
      out.push(`✅ Markdown saved: ${displayPath(file)}`);
    }
    out.push(md);
  }
  return out.join("\n");
}

export function registerDiagramTools(server: McpServer): void {
  server.registerTool(
    "generate_diagram",
    {
      title: "Generate wiring diagram",
      description:
        "Creates a wiring diagram from components and pin connections, as SVG and/or a Markdown table. " +
        "With save_to, writes wiring.svg / wiring.md into that sketch's folder; otherwise the SVG is returned inline.",
      inputSchema: {
        title: z.string().describe("Circuit title"),
        format: formatArg.default("both").describe("Output format"),
        components: z.array(z.object({
          name: z.string().describe("Component name, e.g. ESP32, DHT11"),
          type: z.enum(["microcontroller", "sensor", "actuator", "passive", "power", "display", "communication"]),
          pins: z.array(z.string()).describe("Pins, e.g. [GPIO2, GPIO4, 3V3, GND]"),
        })).min(1).describe("Circuit components"),
        connections: z.array(z.object({
          from: z.string().describe("Source pin, e.g. ESP32 GPIO4"),
          to: z.string().describe("Target pin, e.g. DHT11 DATA"),
          wire: z.string().optional().describe("Wire color: red/black/yellow/green/blue/white/orange/purple/brown/gray"),
          note: z.string().optional().describe("Note, e.g. 10k pull-up"),
        })).describe("Pin connections"),
        notes: z.array(z.string()).optional().describe("General notes"),
        save_to: z.string().optional().describe("Sketch name to save wiring.svg / wiring.md into"),
      },
      annotations: WRITES,
    },
    async ({ title, format, components, connections, notes, save_to }) =>
      ok(await renderDiagram({ title, components, connections, notes }, format, save_to))
  );

  server.registerTool(
    "quick_diagram",
    {
      title: "Quick wiring diagram",
      description:
        "Quick wiring diagram from text, one connection per line: " +
        "'ESP32 GPIO4 -> DHT11 DATA wire:yellow note:10k pull-up' (also '→', '=>' or ' to '). " +
        "The first word of each side is the component name.",
      inputSchema: {
        title: z.string().describe("Circuit title"),
        connections_text: z.string().describe(
          "One per line:\nESP32 GPIO4 -> DHT11 DATA wire:yellow\nESP32 3V3 -> DHT11 VCC wire:red\nESP32 GND -> DHT11 GND wire:black"
        ),
        format: formatArg.default("markdown").describe("Output format"),
        save_to: z.string().optional().describe("Sketch name to save wiring.md / wiring.svg into"),
      },
      annotations: WRITES,
    },
    async ({ title, connections_text, format, save_to }) => {
      const connections = parseConnections(connections_text);
      if (connections.length === 0) {
        throw new UserError("No connections recognized.\nFormat: 'ESP32 GPIO4 -> DHT11 DATA wire:yellow note:10k pull-up'");
      }
      const diagram: CircuitDiagram = { title, components: componentsFromConnections(connections), connections };
      return ok(await renderDiagram(diagram, format, save_to));
    }
  );
}
