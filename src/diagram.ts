/**
 * Circuit Diagram Generator
 * Generates SVG wiring diagrams and pin connection tables
 * No external dependencies required.
 */

export interface PinConnection {
  from: string;      // e.g. "Arduino D2", "ESP32 GPIO4"
  to: string;        // e.g. "DHT11 DATA", "LED Anode"
  wire?: string;     // e.g. "yellow", "red", "black"
  note?: string;     // e.g. "10k pull-up", "330 ohm resistor"
}

export interface Component {
  name: string;
  type: string;      // e.g. "microcontroller", "sensor", "actuator", "passive"
  pins: string[];
  color?: string;
}

export interface CircuitDiagram {
  title: string;
  components: Component[];
  connections: PinConnection[];
  notes?: string[];
}

const COMPONENT_COLORS: Record<string, string> = {
  microcontroller: "#4a90d9",
  sensor: "#7ed321",
  actuator: "#f5a623",
  passive: "#9b9b9b",
  power: "#d0021b",
  display: "#9b59b6",
  communication: "#1abc9c",
};

const WIRE_COLORS: Record<string, string> = {
  red: "#e74c3c",
  black: "#2c3e50",
  yellow: "#f39c12",
  green: "#27ae60",
  blue: "#2980b9",
  white: "#ecf0f1",
  orange: "#e67e22",
  purple: "#8e44ad",
  brown: "#795548",
  gray: "#95a5a6",
};

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escapes text for a Markdown table cell. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function generateSvg(diagram: CircuitDiagram): string {
  const W = 900;
  const compW = 160;
  const maxPins = Math.max(0, ...diagram.components.map((c) => c.pins.length));
  const compH = Math.max(120, 30 + maxPins * 22);
  const cols = Math.max(1, Math.min(diagram.components.length, 4));
  const rows = Math.ceil(diagram.components.length / cols);
  const hGap = 80;
  const vGap = 60;
  const padY = 60;

  const notesH = diagram.notes?.length ? 30 : 0;
  const H = padY + rows * (compH + vGap) + 10 + 36 + diagram.connections.length * 22 + notesH + 20;

  const svgParts: string[] = [];
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#1a1a2e;font-family:monospace">`);

  // Title
  svgParts.push(`<text x="${W / 2}" y="32" text-anchor="middle" fill="#e0e0e0" font-size="18" font-weight="bold">${escapeXml(diagram.title)}</text>`);

  // Component positions
  const positions: Record<string, { x: number; y: number; w: number; h: number }> = {};
  diagram.components.forEach((comp, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const totalRowW = cols * compW + (cols - 1) * hGap;
    const startX = (W - totalRowW) / 2;
    const x = startX + col * (compW + hGap);
    const y = padY + row * (compH + vGap);
    positions[comp.name] = { x, y, w: compW, h: compH };
  });

  // Draw components
  for (const comp of diagram.components) {
    const { x, y, w, h } = positions[comp.name];
    const color = COMPONENT_COLORS[comp.type] || "#666";

    svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${color}22" stroke="${color}" stroke-width="2"/>`);
    svgParts.push(`<text x="${x + w / 2}" y="${y + 18}" text-anchor="middle" fill="${color}" font-size="11" font-weight="bold">${escapeXml(comp.name)}</text>`);
    svgParts.push(`<text x="${x + w / 2}" y="${y + 30}" text-anchor="middle" fill="${color}99" font-size="9">${escapeXml(comp.type)}</text>`);

    comp.pins.forEach((pin, pi) => {
      const py = y + 45 + pi * 22;
      svgParts.push(`<circle cx="${x + 12}" cy="${py}" r="4" fill="${color}"/>`);
      svgParts.push(`<text x="${x + 22}" y="${py + 4}" fill="#e0e0e0" font-size="10">${escapeXml(pin)}</text>`);
    });
  }

  // Draw connections table below components
  const tableY = padY + rows * (compH + vGap) + 10;
  svgParts.push(`<text x="40" y="${tableY + 16}" fill="#e0e0e0" font-size="13" font-weight="bold">Connections:</text>`);

  diagram.connections.forEach((conn, i) => {
    const cy = tableY + 36 + i * 22;
    const wireColor = conn.wire ? (WIRE_COLORS[conn.wire.toLowerCase()] || "#aaa") : "#aaa";
    svgParts.push(`<rect x="40" y="${cy - 12}" width="${W - 80}" height="20" fill="${i % 2 === 0 ? "#ffffff08" : "transparent"}"/>`);
    svgParts.push(`<circle cx="52" cy="${cy}" r="5" fill="${wireColor}"/>`);
    svgParts.push(`<text x="64" y="${cy + 4}" fill="#e0e0e0" font-size="11">${escapeXml(conn.from)}</text>`);
    svgParts.push(`<text x="${W / 2 - 20}" y="${cy + 4}" fill="#888" font-size="11">→</text>`);
    svgParts.push(`<text x="${W / 2}" y="${cy + 4}" fill="#e0e0e0" font-size="11">${escapeXml(conn.to)}</text>`);
    if (conn.note) {
      svgParts.push(`<text x="${W - 44}" y="${cy + 4}" text-anchor="end" fill="#f39c1299" font-size="10">${escapeXml(conn.note)}</text>`);
    }
  });

  // Notes
  if (diagram.notes && diagram.notes.length > 0) {
    const notesY = tableY + 36 + diagram.connections.length * 22 + 10;
    svgParts.push(`<text x="40" y="${notesY}" fill="#f39c12" font-size="11">⚠ ${escapeXml(diagram.notes.join(" | "))}</text>`);
  }

  svgParts.push("</svg>");
  return svgParts.join("\n");
}

export function generateMarkdownTable(diagram: CircuitDiagram): string {
  const lines: string[] = [
    `## ${diagram.title}`,
    "",
    "### Components",
    "",
    "| Component | Type | Pins |",
    "|-----------|------|------|",
  ];

  for (const comp of diagram.components) {
    lines.push(`| **${escapeCell(comp.name)}** | ${escapeCell(comp.type)} | ${escapeCell(comp.pins.join(", "))} |`);
  }

  lines.push("", "### Connections", "", "| From | To | Wire | Note |", "|------|----|------|------|");

  for (const conn of diagram.connections) {
    lines.push(`| ${escapeCell(conn.from)} | ${escapeCell(conn.to)} | ${escapeCell(conn.wire || "—")} | ${escapeCell(conn.note || "—")} |`);
  }

  if (diagram.notes && diagram.notes.length > 0) {
    lines.push("", "### Notes", "");
    for (const note of diagram.notes) {
      lines.push(`> ⚠️ ${note}`);
    }
  }

  return lines.join("\n");
}

// Parses one connection per line:
//   "FROM -> TO [wire:COLOR] [note:TEXT]"   (also "→", "=>" or " to ")
// The arrow word "to" must stand alone, so names like "Button" or "Motor" are safe.
const CONNECTION_RE = /^(.+?)(?:\s*(?:->|→|=>)\s*|\s+to\s+)(.+?)(?:\s+wire:(\S+))?(?:\s+note:(.+))?$/i;

export function parseConnections(text: string): PinConnection[] {
  const connections: PinConnection[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(CONNECTION_RE);
    if (match) {
      connections.push({
        from: match[1].trim(),
        to: match[2].trim(),
        wire: match[3]?.trim(),
        note: match[4]?.trim(),
      });
    }
  }
  return connections;
}

const MCU_RE = /^(arduino|uno|nano|mega|leonardo|micro|esp32|esp8266|nodemcu|wemos|pico|rp2040|stm32|teensy|samd|mkr|xiao)/i;
const POWER_RE = /^(battery|bat|psu|power|vin|vcc|5v|3v3|gnd|usb)/i;

/** Builds components from "COMPONENT PIN" endpoints (first word = component). */
export function componentsFromConnections(connections: PinConnection[]): Component[] {
  const pinsByComp = new Map<string, Set<string>>();
  const add = (endpoint: string) => {
    const [comp, ...rest] = endpoint.split(/\s+/);
    if (!pinsByComp.has(comp)) pinsByComp.set(comp, new Set());
    const pin = rest.join(" ");
    if (pin) pinsByComp.get(comp)!.add(pin);
  };
  for (const c of connections) {
    add(c.from);
    add(c.to);
  }
  return [...pinsByComp].map(([name, pins]) => ({
    name,
    type: MCU_RE.test(name) ? "microcontroller" : POWER_RE.test(name) ? "power" : "sensor",
    pins: [...pins],
  }));
}
