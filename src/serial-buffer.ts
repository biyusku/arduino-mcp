/**
 * Persistent Serial Buffer
 * Keeps a background process reading from a serial port and buffers lines.
 * Any tool can then call readBuffer() to get the latest lines without
 * blocking or re-opening the port.
 */
import { exec, spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

interface BufferSession {
  port: string;
  baud: number;
  proc: ChildProcess;
  lines: string[];
  maxLines: number;
  startedAt: Date;
  byteCount: number;
}

const MAX_LINES = 500;

class SerialBufferManager extends EventEmitter {
  private sessions = new Map<string, BufferSession>();

  start(port: string, baud = 115200): { ok: boolean; message: string } {
    if (this.sessions.has(port)) {
      return { ok: true, message: `Already running on ${port}` };
    }

    // Set baud rate
    exec(`stty -F ${port} ${baud} raw -echo 2>/dev/null`);

    const proc = spawn("cat", [port], { detached: false, stdio: ["ignore", "pipe", "ignore"] });
    const session: BufferSession = {
      port,
      baud,
      proc,
      lines: [],
      maxLines: MAX_LINES,
      startedAt: new Date(),
      byteCount: 0,
    };

    let partial = "";
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      session.byteCount += data.length;
      partial += text;
      const parts = partial.split("\n");
      partial = parts.pop() || "";
      for (const line of parts) {
        const clean = line.replace(/[^\x20-\x7E]/g, "").trim();
        if (clean) {
          session.lines.push(clean);
          if (session.lines.length > session.maxLines) {
            session.lines.shift();
          }
          this.emit("line", port, clean);
        }
      }
    });

    proc.on("close", () => {
      this.sessions.delete(port);
      this.emit("closed", port);
    });

    proc.on("error", () => {
      this.sessions.delete(port);
    });

    this.sessions.set(port, session);
    return { ok: true, message: `Started on ${port} @ ${baud} baud` };
  }

  stop(port: string): { ok: boolean; message: string } {
    const session = this.sessions.get(port);
    if (!session) {
      return { ok: false, message: `No session on ${port}` };
    }
    session.proc.kill("SIGTERM");
    this.sessions.delete(port);
    return { ok: true, message: `Stopped on ${port}` };
  }

  stopAll(): void {
    for (const [, session] of this.sessions) {
      session.proc.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  read(port: string, lines = 50, clear = false): { ok: boolean; lines: string[]; message?: string } {
    const session = this.sessions.get(port);
    if (!session) {
      return { ok: false, lines: [], message: `No active session on ${port}. Start with serial_monitor_start first.` };
    }
    const result = session.lines.slice(-lines);
    if (clear) session.lines = [];
    return { ok: true, lines: result };
  }

  status(): Array<{ port: string; baud: number; lineCount: number; byteCount: number; uptime: string }> {
    const result = [];
    for (const [port, s] of this.sessions) {
      const uptimeMs = Date.now() - s.startedAt.getTime();
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const uptime = uptimeSec < 60
        ? `${uptimeSec}s`
        : `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;
      result.push({ port, baud: s.baud, lineCount: s.lines.length, byteCount: s.byteCount, uptime });
    }
    return result;
  }

  isRunning(port: string): boolean {
    return this.sessions.has(port);
  }

  getSession(port: string): BufferSession | undefined {
    return this.sessions.get(port);
  }
}

export const serialBuffer = new SerialBufferManager();

// Cleanup on exit
process.on("exit", () => serialBuffer.stopAll());
process.on("SIGINT", () => { serialBuffer.stopAll(); process.exit(0); });
process.on("SIGTERM", () => { serialBuffer.stopAll(); process.exit(0); });