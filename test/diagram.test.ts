import assert from "node:assert/strict";
import { test } from "node:test";
import { componentsFromConnections, generateMarkdownTable, generateSvg, parseConnections } from "../src/diagram.js";

test("names containing 'to' are not split (Button, Motor, Potentiometer)", () => {
  const c = parseConnections("Button OUT -> ESP32 GPIO4\nMotor IN1 -> L298N IN1\nPotentiometer WIPER → Arduino A0");
  assert.deepEqual(c.map((x) => [x.from, x.to]), [
    ["Button OUT", "ESP32 GPIO4"],
    ["Motor IN1", "L298N IN1"],
    ["Potentiometer WIPER", "Arduino A0"],
  ]);
});

test("arrow variants, ' to ', wire and note", () => {
  const c = parseConnections(
    "ESP32 GPIO4 -> DHT11 DATA wire:yellow note:10k pull-up\n" +
    "ESP32 3V3 to DHT11 VCC wire:red\n" +
    "  \n" +
    "ESP32 GND=>DHT11 GND\n" +
    "garbage line"
  );
  assert.deepEqual(c, [
    { from: "ESP32 GPIO4", to: "DHT11 DATA", wire: "yellow", note: "10k pull-up" },
    { from: "ESP32 3V3", to: "DHT11 VCC", wire: "red", note: undefined },
    { from: "ESP32 GND", to: "DHT11 GND", wire: undefined, note: undefined },
  ]);
});

test("components are inferred from connections", () => {
  const comps = componentsFromConnections(parseConnections("ESP32 GPIO4 -> DHT11 DATA\nESP32 GND -> DHT11 GND\nBattery + -> ESP32 VIN"));
  assert.deepEqual(comps, [
    { name: "ESP32", type: "microcontroller", pins: ["GPIO4", "GND", "VIN"] },
    { name: "DHT11", type: "sensor", pins: ["DATA", "GND"] },
    { name: "Battery", type: "power", pins: ["+"] },
  ]);
});

test("SVG with no components is still valid (no NaN)", () => {
  const svg = generateSvg({ title: "Empty", components: [], connections: [] });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(!svg.includes("NaN") && !svg.includes("Infinity"));
});

test("SVG escapes text", () => {
  const svg = generateSvg({
    title: "<script>alert(1)</script>",
    components: [{ name: "A&B", type: "sensor", pins: ['"x"'] }],
    connections: [{ from: "A&B x", to: "C <y>" }],
  });
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("A&amp;B") && svg.includes("&lt;y&gt;") && svg.includes("&quot;x&quot;"));
});

test("Markdown table escapes pipes", () => {
  const md = generateMarkdownTable({
    title: "T",
    components: [{ name: "A|B", type: "sensor", pins: ["1"] }],
    connections: [{ from: "A|B 1", to: "C 2", note: "x|y" }],
  });
  assert.ok(md.includes("A\\|B"));
  assert.ok(md.includes("x\\|y"));
});
