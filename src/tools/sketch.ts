import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { displayPath, SKETCHES_DIR } from "../lib/env.js";
import { sketchDir, sketchFile, UserError } from "../lib/validate.js";
import { renderTemplate, TEMPLATE_NAMES } from "../templates.js";
import { DESTRUCTIVE, ok, READ_ONLY, WRITES } from "./util.js";

const nameArg = z.string().describe('Sketch name (letters, digits, "_", "-", "."), e.g. blink_test');

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function mainFile(name: string): Promise<string> {
  return sketchFile(name, `${name}.ino`);
}

export function registerSketchTools(server: McpServer): void {
  server.registerTool(
    "list_sketches",
    {
      title: "List sketches",
      description: "Lists all sketches in the sketches folder (default ~/Arduino) with their last modification date.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      let entries;
      try {
        entries = await fs.readdir(SKETCHES_DIR, { withFileTypes: true });
      } catch {
        return ok(`No sketches yet (${displayPath(SKETCHES_DIR)} does not exist).`);
      }
      const rows: string[] = [];
      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith(".") || d.name === "libraries") continue;
        try {
          const stat = await fs.stat(path.join(SKETCHES_DIR, d.name, `${d.name}.ino`));
          rows.push(`  • ${d.name.padEnd(32)} ${stat.mtime.toISOString().slice(0, 10)}`);
        } catch {
          // folders without a main .ino are not sketches
        }
      }
      if (rows.length === 0) return ok("No sketches yet.");
      return ok(`Sketches (${displayPath(SKETCHES_DIR)}):\n${rows.sort().join("\n")}`);
    }
  );

  server.registerTool(
    "create_sketch",
    {
      title: "Create sketch",
      description: `Creates a new sketch from a template (${TEMPLATE_NAMES.join(", ")}) or from your own code (template "custom"). Refuses to overwrite an existing sketch unless overwrite=true.`,
      inputSchema: {
        name: nameArg,
        template: z.enum([...TEMPLATE_NAMES, "custom"]).default("blink"),
        code: z.string().optional().describe('Sketch code (required for template "custom")'),
        overwrite: z.boolean().default(false).describe("Replace the main .ino if the sketch already exists"),
      },
      annotations: WRITES,
    },
    async ({ name, template, code, overwrite }) => {
      const file = await mainFile(name);
      if (!overwrite && (await exists(file))) {
        throw new UserError(`Sketch "${name}" already exists (${displayPath(file)}). Use write_sketch to change it, or overwrite=true.`);
      }
      let finalCode: string;
      if (template === "custom") {
        if (!code) throw new UserError('Template "custom" needs the code parameter.');
        finalCode = code;
      } else {
        finalCode = renderTemplate(template, name);
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, finalCode, "utf-8");
      return ok(`✅ Sketch created: ${displayPath(file)}\n\n\`\`\`cpp\n${finalCode}\n\`\`\``);
    }
  );

  server.registerTool(
    "read_sketch",
    {
      title: "Read sketch",
      description: "Returns the source of a sketch's main .ino file. Use project_read_file for other files.",
      inputSchema: { name: nameArg },
      annotations: READ_ONLY,
    },
    async ({ name }) => {
      const file = await mainFile(name);
      try {
        const code = await fs.readFile(file, "utf-8");
        return ok(`📄 ${displayPath(file)}:\n\`\`\`cpp\n${code}\n\`\`\``);
      } catch {
        throw new UserError(`Sketch not found: ${displayPath(file)}`);
      }
    }
  );

  server.registerTool(
    "write_sketch",
    {
      title: "Write sketch",
      description: "Writes the main .ino file of a sketch (creates the sketch if needed).",
      inputSchema: { name: nameArg, code: z.string().describe("Arduino code") },
      annotations: WRITES,
    },
    async ({ name, code }) => {
      const file = await mainFile(name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, code, "utf-8");
      return ok(`✅ Sketch saved: ${displayPath(file)}`);
    }
  );

  server.registerTool(
    "delete_sketch",
    {
      title: "Delete sketch",
      description: "Permanently deletes a sketch folder and everything in it.",
      inputSchema: { name: nameArg },
      annotations: DESTRUCTIVE,
    },
    async ({ name }) => {
      const dir = sketchDir(name);
      // Only delete folders that really are sketches.
      if (!(await exists(path.join(dir, `${name}.ino`)))) {
        throw new UserError(`"${name}" is not a sketch (no ${name}.ino in ${displayPath(dir)}); nothing deleted.`);
      }
      await fs.rm(dir, { recursive: true, force: true });
      return ok(`✅ Sketch deleted: ${displayPath(dir)}`);
    }
  );

  server.registerTool(
    "rename_sketch",
    {
      title: "Rename sketch",
      description: "Renames a sketch folder and its main .ino file.",
      inputSchema: {
        old_name: z.string().describe("Current sketch name"),
        new_name: z.string().describe("New sketch name"),
      },
      annotations: WRITES,
    },
    async ({ old_name, new_name }) => {
      const oldDir = sketchDir(old_name);
      const newDir = sketchDir(new_name);
      if (!(await exists(oldDir))) throw new UserError(`Sketch "${old_name}" not found.`);
      if (await exists(newDir)) throw new UserError(`A sketch named "${new_name}" already exists.`);
      await fs.rename(oldDir, newDir);
      const oldIno = path.join(newDir, `${old_name}.ino`);
      if (await exists(oldIno)) await fs.rename(oldIno, path.join(newDir, `${new_name}.ino`));
      return ok(`✅ Renamed "${old_name}" → "${new_name}".`);
    }
  );
}
