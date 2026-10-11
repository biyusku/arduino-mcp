/**
 * Cross-platform serial port detection.
 *
 * USB details (VID/PID/serial) come from the `serialport` package
 * (Linux/macOS/Windows); board names and FQBNs come from
 * `arduino-cli board list --format json`. Either source alone is enough.
 */
import { existsSync } from "fs";
import * as fs from "fs/promises";
import { SerialPort } from "serialport";
import { ARDUINO_CLI } from "./env.js";
import { commandExists, run } from "./exec.js";
import { assertSerialPort, UserError } from "./validate.js";

export type PortRole = "upload" | "monitor" | "both";

export interface MatchingBoard {
  name: string;
  fqbn: string;
}

export interface DetectedPort {
  port: string;
  vendor: string;
  product: string;
  serial: string;
  description: string;
  role: PortRole;
  boards: MatchingBoard[];
}

export interface CliPort {
  address: string;
  protocol: string;
  label: string;
  vid: string;
  pid: string;
  serial: string;
  boards: MatchingBoard[];
}

function normalizeHex(v: string | undefined): string {
  return (v || "").toLowerCase().replace(/^0x/, "");
}

/** Parses `arduino-cli board list --format json` (handles the pre-1.0 array format too). */
export function parseBoardListJson(raw: string): CliPort[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries: unknown[] = Array.isArray(data)
    ? data
    : ((data as { detected_ports?: unknown[] })?.detected_ports ?? []);

  const result: CliPort[] = [];
  for (const e of entries) {
    const entry = e as {
      port?: { address?: string; protocol?: string; label?: string; properties?: Record<string, string> };
      matching_boards?: Array<{ name?: string; fqbn?: string }>;
    };
    if (!entry.port?.address) continue;
    const props = entry.port.properties || {};
    result.push({
      address: entry.port.address,
      protocol: entry.port.protocol || "",
      label: entry.port.label || entry.port.address,
      vid: normalizeHex(props.vid),
      pid: normalizeHex(props.pid),
      serial: props.serialNumber || "",
      boards: (entry.matching_boards || [])
        .filter((b) => b.fqbn)
        .map((b) => ({ name: b.name || b.fqbn!, fqbn: b.fqbn! })),
    });
  }
  return result;
}

export async function listCliPorts(): Promise<CliPort[]> {
  const r = await run(ARDUINO_CLI, ["board", "list", "--format", "json"], { timeoutMs: 20_000 });
  return r.ok ? parseBoardListJson(r.stdout) : [];
}

interface OsPort {
  path: string;
  vendor: string;
  product: string;
  serial: string;
  manufacturer: string;
}

async function listOsPorts(): Promise<OsPort[]> {
  // serialport's Linux lister spawns `udevadm` without an error handler, so a
  // missing udevadm would crash the whole server. Check first.
  if (process.platform === "linux" && !commandExists("udevadm")) return [];
  try {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      // macOS: callers should use the "call-out" device, which does not block on open
      path: process.platform === "darwin" ? p.path.replace(/^\/dev\/tty\./, "/dev/cu.") : p.path,
      vendor: normalizeHex(p.vendorId),
      product: normalizeHex(p.productId),
      serial: p.serialNumber || "",
      manufacturer: p.manufacturer || "",
    }));
  } catch {
    return [];
  }
}

export function roleForVendor(vendor: string): PortRole {
  // CH340/CH341/CH343 bridges next to a native-USB ESP32-S3 are used for upload,
  // the Espressif native USB port (303a) for the serial monitor. Everything else
  // (Uno/Mega via 16U2, CP210x, FTDI, Leonardo, RP2040, ...) does both.
  if (vendor === "1a86") return "upload";
  if (vendor === "303a") return "monitor";
  return "both";
}

/** Merges OS and arduino-cli port lists; only USB-backed ports are returned. */
export function mergePorts(osPorts: OsPort[], cliPorts: CliPort[]): DetectedPort[] {
  const byPort = new Map<string, DetectedPort>();
  for (const p of osPorts) {
    if (!p.vendor) continue; // e.g. legacy /dev/ttyS* without USB backing
    byPort.set(p.path, {
      port: p.path,
      vendor: p.vendor,
      product: p.product,
      serial: p.serial,
      description: p.manufacturer,
      role: roleForVendor(p.vendor),
      boards: [],
    });
  }
  for (const c of cliPorts) {
    if (c.protocol && c.protocol !== "serial") continue;
    const existing = byPort.get(c.address);
    if (existing) {
      existing.boards = c.boards;
      existing.serial ||= c.serial;
      continue;
    }
    if (!c.vid && c.boards.length === 0) continue;
    byPort.set(c.address, {
      port: c.address,
      vendor: c.vid,
      product: c.pid,
      serial: c.serial,
      description: c.label,
      role: roleForVendor(c.vid),
      boards: c.boards,
    });
  }
  return [...byPort.values()].sort((a, b) => a.port.localeCompare(b.port));
}

/**
 * Returns a function telling whether a serial port is connected right now.
 * Unix ports are device files; Windows COM ports are not files, so they are
 * looked up in the system's port list (case-insensitively).
 */
export async function portPresenceChecker(
  platform: string = process.platform,
  list: () => Promise<Array<{ path: string }>> = () => SerialPort.list()
): Promise<(port: string) => boolean> {
  if (platform !== "win32") return (port) => existsSync(port);
  const comName = (p: string) => p.replace(/^\\\\\.\\/, "").toUpperCase();
  let present: Set<string>;
  try {
    present = new Set((await list()).map((p) => comName(p.path)));
  } catch {
    return () => true; // cannot tell; keep the configured port
  }
  return (port) => present.has(comName(port));
}

export async function detectPorts(): Promise<DetectedPort[]> {
  const [osPorts, cliPorts] = await Promise.all([listOsPorts(), listCliPorts()]);
  return mergePorts(osPorts, cliPorts);
}

export interface AutoDetectResult {
  uploadPort: string;
  monitorPort: string;
  serial: string;
  fqbn?: string;
  boardName?: string;
  /** Other boards arduino-cli considers possible for the same VID/PID */
  alternatives: MatchingBoard[];
  /** True when two USB devices were combined as one dual-USB board (e.g. ESP32-S3: CH343 + native USB) */
  paired: boolean;
  /** USB serial ports that belong to other boards */
  otherPorts: DetectedPort[];
  /** All USB serial ports seen */
  ports: DetectedPort[];
}

interface BoardCandidate {
  upload: DetectedPort;
  monitor: DetectedPort;
  paired: boolean;
}

/**
 * Groups ports into boards. Each port is its own board, except that exactly
 * one upload-only bridge (CH34x) plus exactly one monitor-only native USB port
 * (Espressif) are treated as the two ports of one dual-USB board. Ports of
 * different boards are never mixed.
 */
export function groupBoards(ports: DetectedPort[]): BoardCandidate[] {
  const uploads = ports.filter((p) => p.role === "upload");
  const monitors = ports.filter((p) => p.role === "monitor");
  const candidates: BoardCandidate[] = [];
  if (uploads.length === 1 && monitors.length === 1) {
    candidates.push({ upload: uploads[0], monitor: monitors[0], paired: true });
  } else {
    for (const p of [...uploads, ...monitors]) candidates.push({ upload: p, monitor: p, paired: false });
  }
  for (const p of ports.filter((p) => p.role === "both")) candidates.push({ upload: p, monitor: p, paired: false });
  // dual-USB pairs first, then boards arduino-cli could identify
  const rank = (c: BoardCandidate) => (c.paired ? 0 : c.upload.boards.length || c.monitor.boards.length ? 1 : 2);
  return candidates.map((c, i) => ({ c, i })).sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i).map((x) => x.c);
}

export function pickPorts(ports: DetectedPort[]): AutoDetectResult | null {
  const chosen = groupBoards(ports)[0];
  if (!chosen) return null;
  const { upload: up, monitor: mp } = chosen;
  const boards = up.boards.length ? up.boards : mp.boards;
  return {
    uploadPort: up.port,
    monitorPort: mp.port,
    serial: up.serial || mp.serial || `${up.vendor}:${up.product}`,
    fqbn: boards[0]?.fqbn,
    boardName: boards[0]?.name,
    alternatives: boards.slice(1),
    paired: chosen.paired,
    otherPorts: ports.filter((p) => p !== up && p !== mp),
    ports,
  };
}

export async function autoDetect(): Promise<AutoDetectResult | null> {
  return pickPorts(await detectPorts());
}

/**
 * Checks that the port exists and that we may open it. Returns an error
 * message with a fix, or null. (We never chmod devices or call sudo.)
 */
export async function checkPortAccess(port: string): Promise<string | null> {
  assertSerialPort(port);
  if (process.platform === "win32") return null;
  try {
    await fs.access(port, fs.constants.R_OK | fs.constants.W_OK);
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `Port ${port} not found. Is the board plugged in? Run detect_board to refresh ports.`;
    if (code === "EACCES" || code === "EPERM") {
      return process.platform === "linux"
        ? `No permission to open ${port}. Add your user to the serial group once and log in again:\n` +
          "  sudo usermod -aG dialout $USER   (Arch/Fedora: uucp or dialout)"
        : `No permission to open ${port}.`;
    }
    return `Cannot open ${port}: ${(e as Error).message}`;
  }
}

export async function assertPortAccessible(port: string): Promise<void> {
  const problem = await checkPortAccess(port);
  if (problem) throw new UserError(problem);
}

// Real serial devices. Terminals (/dev/tty, /dev/pts/N, /dev/ttys00N) and
// other devices such as /dev/null are open in nearly every process, so they
// must never be "released".
const SERIAL_DEVICE_RE = /^\/dev\/(?:tty(?:USB|ACM|AMA|S|XRUSB|WCH|MFD|SAC|THS|O)\d+|rfcomm\d+|(?:cu|tty)\.[^/]+)$/;

/** True if `port` (after resolving symlinks such as /dev/serial/by-id/...) is a serial character device. */
export async function isReleasableSerialPort(port: string): Promise<boolean> {
  try {
    const real = await fs.realpath(port);
    if (!SERIAL_DEVICE_RE.test(real)) return false;
    return (await fs.stat(real)).isCharacterDevice();
  } catch {
    return false;
  }
}

/**
 * Terminates other processes that hold a serial port open (e.g. a forgotten
 * serial monitor), so an upload can use it. Only real serial devices are
 * handled, and neither this server nor its parent (the MCP client) is ever
 * touched; our own serial sessions are paused separately. Returns what was stopped.
 */
export async function releasePort(
  port: string,
  isReleasable: (port: string) => Promise<boolean> = isReleasableSerialPort
): Promise<string[]> {
  assertSerialPort(port);
  if (process.platform === "win32" || !(await isReleasable(port))) return [];
  const device = await fs.realpath(port);
  const r = await run("lsof", ["-t", "--", device], { timeoutMs: 10_000 });
  const pids = r.stdout
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid);

  const stopped: string[] = [];
  for (const pid of [...new Set(pids)]) {
    const ps = await run("ps", ["-p", String(pid), "-o", "comm="], { timeoutMs: 5_000 });
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(`${ps.stdout || "process"} (pid ${pid})`);
    } catch {
      // already gone or not ours to kill
    }
  }
  return stopped;
}
