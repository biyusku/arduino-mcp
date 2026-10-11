import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { cleanLine, LineBuffer, SerialManager, type PortHandle } from "../src/serial-buffer.js";

class FakePort extends EventEmitter implements PortHandle {
  isOpen = false;
  written: string[] = [];
  constructor(public path: string, public baud: number, private failOpen = false) {
    super();
  }
  open(cb: (err: Error | null) => void): void {
    setImmediate(() => {
      if (this.failOpen) return cb(new Error("Resource busy"));
      this.isOpen = true;
      cb(null);
    });
  }
  close(cb?: (err?: Error | null) => void): void {
    this.isOpen = false;
    setImmediate(() => {
      cb?.(null);
      this.emit("close");
    });
  }
  write(data: string | Buffer, cb?: (err?: Error | null) => void): boolean {
    this.written.push(String(data));
    setImmediate(() => cb?.(null));
    return true;
  }
  drain(cb: (err: Error | null) => void): void {
    setImmediate(() => cb(null));
  }
  feed(text: string | Buffer): void {
    this.emit("data", Buffer.isBuffer(text) ? text : Buffer.from(text));
  }
}

function setup(opts: { failOpens?: number } = {}) {
  const ports: FakePort[] = [];
  let failures = opts.failOpens ?? 0;
  const mgr = new SerialManager((p, b) => {
    const port = new FakePort(p, b, failures-- > 0);
    ports.push(port);
    return port;
  });
  return { mgr, ports };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("cleanLine strips ANSI colors and control chars, keeps UTF-8", () => {
  assert.equal(cleanLine("\x1b[0;32mI (31) boot: ok\x1b[0m\r"), "I (31) boot: ok");
  assert.equal(cleanLine("sıcaklık: 23°C\r"), "sıcaklık: 23°C");
  assert.equal(cleanLine("a\tb\x00\x07"), "a\tb");
});

test("LineBuffer joins chunks, handles UTF-8 split across chunks", () => {
  const b = new LineBuffer();
  const bytes = Buffer.from("çalışıyor\r\nikinci");
  b.push(bytes.subarray(0, 2)); // splits "ç" in the middle
  b.push(bytes.subarray(2));
  assert.deepEqual(b.lines, ["çalışıyor"]);
  b.flush();
  assert.deepEqual(b.lines, ["çalışıyor", "ikinci"]);
});

test("LineBuffer keeps the newest lines and tracks 'since'", () => {
  const b = new LineBuffer(3);
  for (let i = 1; i <= 5; i++) b.push(Buffer.from(`line ${i}\n`));
  assert.deepEqual(b.lines, ["line 3", "line 4", "line 5"]);
  const mark = b.total;
  b.push(Buffer.from("line 6\n\n\nline 7\n"));
  assert.deepEqual(b.since(mark), ["line 6", "line 7"]);
});

test("session: start, read, clear, stop", async () => {
  const { mgr, ports } = setup();
  assert.match(await mgr.start("/dev/ttyACM0", 115200), /Started/);
  assert.match(await mgr.start("/dev/ttyACM0", 115200), /Already running/);
  assert.equal(ports.length, 1);
  ports[0].feed("hello\r\nworld\r\n");
  assert.deepEqual(mgr.read("/dev/ttyACM0", 1, false), ["world"]);
  assert.deepEqual(mgr.read("/dev/ttyACM0", 10, true), ["hello", "world"]);
  assert.deepEqual(mgr.read("/dev/ttyACM0", 10, false), []);
  assert.equal(mgr.status()[0].byteCount, 14);
  assert.equal(await mgr.stop("/dev/ttyACM0"), true);
  assert.equal(ports[0].isOpen, false);
  assert.equal(mgr.read("/dev/ttyACM0", 10, false), null);
});

test("late close event of an old session does not kill the new one", async () => {
  const { mgr, ports } = setup();
  await mgr.start("/dev/ttyACM0", 9600);
  await mgr.stop("/dev/ttyACM0");
  await mgr.start("/dev/ttyACM0", 115200);
  ports[0].emit("close"); // old port reports close after the new session started
  assert.equal(mgr.isRunning("/dev/ttyACM0"), true);
  assert.equal(mgr.status()[0].baud, 115200);
});

test("unplugged device removes its session", async () => {
  const { mgr, ports } = setup();
  await mgr.start("/dev/ttyACM0", 9600);
  ports[0].emit("close");
  assert.equal(mgr.isRunning("/dev/ttyACM0"), false);
});

test("changing baud reopens the port", async () => {
  const { mgr, ports } = setup();
  await mgr.start("/dev/ttyACM0", 9600);
  await mgr.start("/dev/ttyACM0", 115200);
  assert.equal(ports.length, 2);
  assert.equal(ports[0].isOpen, false);
  assert.equal(ports[1].baud, 115200);
});

test("open errors are reported", async () => {
  const { mgr } = setup({ failOpens: 1 });
  await assert.rejects(mgr.start("/dev/ttyACM0", 9600), /Cannot open \/dev\/ttyACM0: Resource busy/);
  assert.equal(mgr.isRunning("/dev/ttyACM0"), false);
});

test("send through a running session writes without reopening and returns only new lines", async () => {
  const { mgr, ports } = setup();
  await mgr.start("/dev/ttyACM0", 115200);
  ports[0].feed("old line\n");
  setTimeout(() => ports[0].feed("OK LED_ON\n"), 20);
  const reply = await mgr.send("/dev/ttyACM0", 115200, "LED_ON\n", 80, 2000);
  assert.deepEqual(ports[0].written, ["LED_ON\n"]);
  assert.deepEqual(reply, ["OK LED_ON"]);
  assert.equal(ports.length, 1);
});

test("one-shot send opens, waits, writes, closes", async () => {
  const { mgr, ports } = setup();
  const p = mgr.send("/dev/ttyUSB0", 9600, "ping\n", 60, 40);
  await wait(10);
  ports[0].feed("boot message\n"); // arrives before the write → not part of the reply
  await wait(50);
  assert.deepEqual(ports[0].written, ["ping\n"]);
  ports[0].feed("pong");
  assert.deepEqual(await p, ["pong"]);
  assert.equal(ports[0].isOpen, false);
});

test("readFor without a session opens temporarily", async () => {
  const { mgr, ports } = setup();
  const p = mgr.readFor("/dev/ttyUSB0", 9600, 60);
  await wait(10);
  ports[0].feed("a\nb");
  assert.deepEqual(await p, ["a", "b"]);
  assert.equal(ports[0].isOpen, false);
  assert.equal(mgr.isRunning("/dev/ttyUSB0"), false);
});

test("pause/resume around an upload only touches the given ports", async () => {
  const { mgr, ports } = setup();
  await mgr.start("/dev/ttyACM0", 115200);
  await mgr.start("/dev/ttyACM1", 9600);
  const resume = await mgr.pause(["/dev/ttyACM0", "/dev/ttyACM9"]);
  assert.equal(mgr.isRunning("/dev/ttyACM0"), false);
  assert.equal(mgr.isRunning("/dev/ttyACM1"), true); // untouched

  const notes = await resume();
  assert.deepEqual(notes, ["Serial session on /dev/ttyACM0 resumed."]);
  assert.equal(mgr.isRunning("/dev/ttyACM0"), true);
  assert.equal(ports.at(-1)!.baud, 115200);
});

test("resume retries failed opens", async () => {
  let attempts = 0;
  const mgr = new SerialManager((p, b) => new FakePort(p, b, attempts++ >= 1 && attempts <= 3));
  await mgr.start("/dev/ttyACM0", 115200); // attempt 1 ok
  const resume = await mgr.pause(["/dev/ttyACM0"]);
  const notes = await resume(); // attempts 2,3 fail, 4 ok
  assert.deepEqual(notes, ["Serial session on /dev/ttyACM0 resumed."]);
  assert.equal(attempts, 4);
});
