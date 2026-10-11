/**
 * Serial port access via the `serialport` package (Linux, macOS, Windows).
 *
 * - Persistent sessions keep a port open in the background and buffer lines,
 *   so any tool can read the latest output (and write to the board) without
 *   re-opening the port.
 * - One-shot reads/sends open the port only for the duration of the call.
 *
 * Ports are opened with hupcl=false: DTR is not dropped on close, so boards
 * with DTR auto-reset (Uno, Nano, Mega) are not reset again on the next open.
 */
import { SerialPort } from "serialport";
import { sleep } from "./lib/exec.js";
import { UserError } from "./lib/validate.js";

const MAX_LINES = 500;
const MAX_PARTIAL_BYTES = 4096;

/** The subset of SerialPort we use; lets tests substitute a fake port. */
export interface PortHandle {
  readonly isOpen: boolean;
  open(cb: (err: Error | null) => void): void;
  close(cb?: (err?: Error | null) => void): void;
  write(data: string | Buffer, cb?: (err?: Error | null) => void): boolean;
  drain(cb: (err: Error | null) => void): void;
  on(event: "data", listener: (data: Buffer) => void): unknown;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): unknown;
}

export type PortFactory = (path: string, baudRate: number) => PortHandle;

const defaultFactory: PortFactory = (path, baudRate) =>
  new SerialPort({ path, baudRate, autoOpen: false, hupcl: false }) as unknown as PortHandle;

/** Removes ANSI color codes and control characters, keeps UTF-8 text. */
export function cleanLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
    .trimEnd();
}

/** Splits a byte stream into cleaned lines, keeping only the most recent ones. */
export class LineBuffer {
  lines: string[] = [];
  /** Total number of lines ever added; used to find lines that arrived "since" a point. */
  total = 0;
  private partial = Buffer.alloc(0);

  constructor(private readonly max = MAX_LINES) {}

  push(chunk: Buffer): void {
    let data = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let nl: number;
    while ((nl = data.indexOf(0x0a)) !== -1) {
      this.add(data.subarray(0, nl).toString("utf-8"));
      data = data.subarray(nl + 1);
    }
    this.partial = Buffer.from(data);
    if (this.partial.length > MAX_PARTIAL_BYTES) this.flush();
  }

  /** Emits any unterminated text as a final line. */
  flush(): void {
    if (this.partial.length) {
      this.add(this.partial.toString("utf-8"));
      this.partial = Buffer.alloc(0);
    }
  }

  since(total: number): string[] {
    const count = Math.min(this.total - total, this.lines.length);
    return count > 0 ? this.lines.slice(-count) : [];
  }

  clear(): void {
    this.lines = [];
  }

  /** Adds a line of our own (e.g. a disconnect marker), after any unterminated text. */
  note(text: string): void {
    this.flush();
    this.add(text);
  }

  private add(raw: string): void {
    const line = cleanLine(raw);
    if (!line.trim()) return;
    this.lines.push(line);
    this.total++;
    if (this.lines.length > this.max) this.lines.shift();
  }
}

interface Session {
  port: string;
  baud: number;
  handle: PortHandle | null;
  /** false while the device is gone (e.g. a native-USB board resetting) */
  connected: boolean;
  retry?: NodeJS.Timeout;
  buffer: LineBuffer;
  startedAt: Date;
  bytes: number;
}

export interface SessionStatus {
  port: string;
  baud: number;
  connected: boolean;
  lineCount: number;
  byteCount: number;
  uptime: string;
}

function closeHandle(h: PortHandle): Promise<void> {
  return new Promise((resolve) => {
    if (!h.isOpen) return resolve();
    const t = setTimeout(resolve, 2000); // never hang on a vanished device
    h.close(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

function writeHandle(h: PortHandle, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    h.write(data, (err) => {
      if (err) return reject(err);
      h.drain((e) => (e ? reject(e) : resolve()));
    });
  });
}

export class SerialManager {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly factory: PortFactory = defaultFactory,
    /** How often to try to reopen a port whose device went away */
    private readonly reconnectMs = 1_000
  ) {}

  private open(port: string, baud: number): Promise<PortHandle> {
    const h = this.factory(port, baud);
    // Swallow async errors (e.g. device unplugged); "close" handles cleanup.
    h.on("error", () => {});
    return new Promise((resolve, reject) => {
      h.open((err) => (err ? reject(new UserError(`Cannot open ${port}: ${err.message}`)) : resolve(h)));
    });
  }

  async start(port: string, baud: number): Promise<string> {
    const existing = this.sessions.get(port);
    if (existing) {
      if (existing.baud === baud) return `Already running on ${port} @ ${baud} baud`;
      await this.stop(port);
    }

    const handle = await this.open(port, baud);
    if (this.sessions.has(port)) {
      // Another call started a session while we were opening.
      await closeHandle(handle);
      return `Already running on ${port}`;
    }

    const session: Session = { port, baud, handle: null, connected: false, buffer: new LineBuffer(), startedAt: new Date(), bytes: 0 };
    this.attach(session, handle);
    this.sessions.set(port, session);
    return `Started on ${port} @ ${baud} baud`;
  }

  private attach(session: Session, handle: PortHandle): void {
    session.handle = handle;
    session.connected = true;
    const current = () => this.sessions.get(session.port) === session && session.handle === handle;
    handle.on("data", (d: Buffer) => {
      if (!current()) return;
      session.bytes += d.length;
      session.buffer.push(d);
    });
    handle.on("close", () => {
      // Ignore closes of stopped/replaced sessions. Otherwise the device went
      // away (native-USB boards re-enumerate on every reset, crash or
      // watchdog restart): keep the session and its output (often exactly
      // the crash message) and reconnect when the device is back.
      if (!current()) return;
      session.handle = null;
      session.connected = false;
      session.buffer.note(`--- [arduino-mcp] ${session.port} disconnected, reconnecting ---`);
      this.scheduleReconnect(session);
    });
  }

  private scheduleReconnect(session: Session): void {
    session.retry = setTimeout(async () => {
      if (this.sessions.get(session.port) !== session) return;
      try {
        const handle = await this.open(session.port, session.baud);
        if (this.sessions.get(session.port) !== session) {
          await closeHandle(handle); // stopped while we were reopening
          return;
        }
        this.attach(session, handle);
        session.buffer.note(`--- [arduino-mcp] ${session.port} reconnected ---`);
      } catch {
        this.scheduleReconnect(session);
      }
    }, this.reconnectMs);
    session.retry.unref();
  }

  async stop(port: string): Promise<boolean> {
    const s = this.sessions.get(port);
    if (!s) return false;
    this.sessions.delete(port);
    clearTimeout(s.retry);
    if (s.handle) await closeHandle(s.handle);
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((p) => this.stop(p)));
  }

  isRunning(port: string): boolean {
    return this.sessions.has(port);
  }

  /** False while a running session waits for its device to come back. */
  isConnected(port: string): boolean {
    return this.sessions.get(port)?.connected ?? false;
  }

  /** Baud rate of the running session on this port, if any. */
  sessionBaud(port: string): number | undefined {
    return this.sessions.get(port)?.baud;
  }

  read(port: string, lines: number, clear: boolean): string[] | null {
    const s = this.sessions.get(port);
    if (!s) return null;
    const result = s.buffer.lines.slice(-lines);
    if (clear) s.buffer.clear();
    return result;
  }

  status(): SessionStatus[] {
    return [...this.sessions.values()].map((s) => {
      const sec = Math.floor((Date.now() - s.startedAt.getTime()) / 1000);
      return {
        port: s.port,
        baud: s.baud,
        connected: s.connected,
        lineCount: s.buffer.lines.length,
        byteCount: s.bytes,
        uptime: sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`,
      };
    });
  }

  /** Reads for `ms` milliseconds. Uses the running session if there is one. */
  async readFor(port: string, baud: number, ms: number): Promise<string[]> {
    const s = this.sessions.get(port);
    if (s) {
      const mark = s.buffer.total;
      await sleep(ms);
      return s.buffer.since(mark);
    }
    const h = await this.open(port, baud);
    const buffer = new LineBuffer();
    h.on("data", (d: Buffer) => buffer.push(d));
    await sleep(ms);
    await closeHandle(h);
    buffer.flush();
    return buffer.lines;
  }

  /**
   * Sends data and returns the lines received in the next `responseMs`.
   * Uses the running session if there is one (no re-open, no reset).
   * Otherwise opens the port, waits `openDelayMs` (boards that reset on open
   * need time to boot) and then writes.
   */
  async send(port: string, baud: number, data: string, responseMs: number, openDelayMs: number): Promise<string[]> {
    const s = this.sessions.get(port);
    if (s) {
      if (!s.handle) throw new UserError(`${port} is disconnected (the background session is reconnecting); try again in a moment.`);
      const mark = s.buffer.total;
      await writeHandle(s.handle, data);
      await sleep(responseMs);
      return s.buffer.since(mark);
    }
    const h = await this.open(port, baud);
    const buffer = new LineBuffer();
    h.on("data", (d: Buffer) => buffer.push(d));
    try {
      if (openDelayMs > 0) await sleep(openDelayMs);
      const mark = buffer.total;
      await writeHandle(h, data);
      await sleep(responseMs);
      buffer.flush();
      return buffer.since(mark);
    } finally {
      await closeHandle(h);
    }
  }

  /**
   * Closes our sessions on the given ports (e.g. before an upload) and
   * returns a function that re-opens them afterwards.
   */
  async pause(ports: string[]): Promise<() => Promise<string[]>> {
    const paused: Array<{ port: string; baud: number }> = [];
    for (const port of new Set(ports)) {
      const s = this.sessions.get(port);
      if (s) {
        paused.push({ port, baud: s.baud });
        await this.stop(port);
      }
    }
    return async () => {
      const notes: string[] = [];
      for (const p of paused) {
        let error: unknown = null;
        // Native-USB boards re-enumerate after reset; give them a few seconds.
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await this.start(p.port, p.baud);
            error = null;
            break;
          } catch (e) {
            error = e;
            await sleep(500);
          }
        }
        notes.push(error
          ? `Could not resume serial session on ${p.port}: ${(error as Error).message}`
          : `Serial session on ${p.port} resumed.`);
      }
      return notes;
    };
  }
}

export const serialBuffer = new SerialManager();
