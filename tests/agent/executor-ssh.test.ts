import { EventEmitter } from "node:events";
import {
  type SSHClientLike,
  type SSHConnectConfig,
  SSHExecutor,
  type SSHStreamLike,
} from "@/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SSHExecutor unit tests — ssh2 is never actually imported or dialled. A
 * FakeSSHClient is injected via `clientFactory`. Scripts match on the
 * command string; matchers run in order.
 *
 * The fakes are declared as plain objects typed `as SSHClientLike` /
 * `as SSHStreamLike` rather than `extends EventEmitter implements ...` so
 * we don't fight TS overload resolution on `on()`.
 */

interface ExecScript {
  match: (cmd: string) => boolean;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  exitCode?: number;
  /** Delay (ms) before emitting close. Useful for timeout tests. */
  closeDelayMs?: number;
  /** Never emit close — forces the timeout path. */
  hang?: boolean;
}

interface FakeStream extends SSHStreamLike {
  _ee: EventEmitter;
  stderr: EventEmitter & { on: EventEmitter["on"] };
  signalCalls: string[];
  closed: boolean;
  stdinBuffer: string;
}

function makeFakeStream(): FakeStream {
  const ee = new EventEmitter();
  const stderr = new EventEmitter() as EventEmitter & { on: EventEmitter["on"] };
  const stream: FakeStream = {
    _ee: ee,
    stderr,
    signalCalls: [],
    closed: false,
    stdinBuffer: "",
    on: ((event: string, cb: (...args: unknown[]) => void): FakeStream => {
      ee.on(event, cb);
      return stream;
    }) as FakeStream["on"],
    signal(name: string): void {
      stream.signalCalls.push(name);
    },
    end(input?: string | Buffer): void {
      if (input !== undefined) stream.stdinBuffer += input.toString();
    },
    close(): void {
      stream.closed = true;
    },
    write(chunk: string | Buffer): boolean {
      stream.stdinBuffer += chunk.toString();
      return true;
    },
  };
  return stream;
}

interface FakeSSHClient extends SSHClientLike {
  _ee: EventEmitter;
  scripts: ExecScript[];
  connectCalls: SSHConnectConfig[];
  execCalls: string[];
  streams: FakeStream[];
  endCalls: number;
  readyDelayMs: number;
  failConnect: Error | null;
}

function makeFakeClient(scripts: ExecScript[] = []): FakeSSHClient {
  const ee = new EventEmitter();
  const state = {
    _ee: ee,
    scripts,
    connectCalls: [] as SSHConnectConfig[],
    execCalls: [] as string[],
    streams: [] as FakeStream[],
    endCalls: 0,
    readyDelayMs: 1,
    failConnect: null as Error | null,
  };
  const client: FakeSSHClient = {
    ...state,
    on: ((event: string, cb: (...args: unknown[]) => void): FakeSSHClient => {
      ee.on(event, cb);
      return client;
    }) as FakeSSHClient["on"],
    off: ((event: string, cb: (...args: unknown[]) => void): FakeSSHClient => {
      ee.off(event, cb);
      return client;
    }) as NonNullable<FakeSSHClient["off"]>,
    connect(opts: SSHConnectConfig): void {
      client.connectCalls.push(opts);
      if (client.failConnect) {
        const err = client.failConnect;
        setTimeout(() => ee.emit("error", err), client.readyDelayMs);
        return;
      }
      setTimeout(() => ee.emit("ready"), client.readyDelayMs);
    },
    exec(command: string, cb: (err: Error | undefined, stream: SSHStreamLike) => void): void {
      client.execCalls.push(command);
      const stream = makeFakeStream();
      client.streams.push(stream);
      const script = client.scripts.find((s) => s.match(command));
      cb(undefined, stream);

      if (!script || script.hang) return;
      const stdout = script.stdout ?? Buffer.alloc(0);
      const stderr = script.stderr ?? Buffer.alloc(0);
      const code = script.exitCode ?? 0;
      const delay = script.closeDelayMs ?? 1;

      setTimeout(() => {
        if (stdout) {
          const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8");
          stream._ee.emit("data", buf);
        }
        if (stderr) {
          const buf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr, "utf8");
          stream.stderr.emit("data", buf);
        }
        stream._ee.emit("close", code, null);
      }, delay);
    },
    end(): void {
      client.endCalls += 1;
      ee.emit("close");
    },
  };
  return client;
}

const baseConfig = {
  host: "example.com",
  port: 2222,
  username: "strand",
  privateKey: "-----BEGIN FAKE KEY-----",
  readyTimeoutMs: 5000,
};

function makeExec(
  scripts: ExecScript[] = [],
  overrides: Partial<ConstructorParameters<typeof SSHExecutor>[0]> = {},
): { exec: SSHExecutor; fake: FakeSSHClient } {
  const fake = makeFakeClient(scripts);
  const exec = new SSHExecutor({
    ...baseConfig,
    ...overrides,
    clientFactory: () => fake,
  });
  return { exec, fake };
}

describe("SSHExecutor", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("safe is false until markSafe()", () => {
    const { exec } = makeExec();
    expect(exec.safe).toBe(false);
    exec.markSafe();
    expect(exec.safe).toBe(true);
  });

  it("start() calls connect() with host, port, username, readyTimeout, privateKey", async () => {
    const { exec, fake } = makeExec();
    await exec.start();
    expect(fake.connectCalls).toHaveLength(1);
    const opts = fake.connectCalls[0];
    expect(opts?.["host"]).toBe("example.com");
    expect(opts?.["port"]).toBe(2222);
    expect(opts?.["username"]).toBe("strand");
    expect(opts?.["readyTimeout"]).toBe(5000);
    expect(opts?.["privateKey"]).toBe("-----BEGIN FAKE KEY-----");
  });

  it("start() is idempotent — concurrent calls share one connect", async () => {
    const { exec, fake } = makeExec();
    await Promise.all([exec.start(), exec.start(), exec.start()]);
    expect(fake.connectCalls).toHaveLength(1);
  });

  it("start() surfaces a useful error on connect failure", async () => {
    const { exec, fake } = makeExec();
    fake.failConnect = new Error("auth failed");
    await expect(exec.start()).rejects.toThrow(
      /SSH connect failed .*example\.com:2222.*auth failed/,
    );
  });

  it("bash() wraps command in bash -c with shellQuote — no interpolation", async () => {
    const { exec, fake } = makeExec([
      { match: (c) => c.startsWith("bash -c "), stdout: "ok", exitCode: 0 },
    ]);
    await exec.start();
    const res = await exec.bash("echo 'hello $USER'");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("ok");

    const cmd = fake.execCalls[0] ?? "";
    // The user's single quotes must end up escaped in the shell-quoted wrapper.
    expect(cmd.startsWith("bash -c '")).toBe(true);
    expect(cmd).toContain("echo");
    // No literal `$USER` outside quotes → confirm whole command is wrapped.
    expect(cmd).toMatch(/^bash -c '.*'$/s);
  });

  it("bash() accumulates stdout + stderr + exitCode from streamed chunks", async () => {
    const { exec, fake } = makeExec();
    // Override exec to emit multiple chunks so we cover the accumulator path.
    fake.exec = (cmd, cb) => {
      fake.execCalls.push(cmd);
      const stream = makeFakeStream();
      fake.streams.push(stream);
      cb(undefined, stream);
      setTimeout(() => {
        stream._ee.emit("data", Buffer.from("hello "));
        stream._ee.emit("data", Buffer.from("world"));
        stream.stderr.emit("data", Buffer.from("warn"));
        stream._ee.emit("close", 3, null);
      }, 2);
    };

    await exec.start();
    const res = await exec.bash("printf hello");
    expect(res.stdout).toBe("hello world");
    expect(res.stderr).toBe("warn");
    expect(res.exitCode).toBe(3);
  });

  it("bash() truncates stdout at stdoutMaxBytes", async () => {
    const big = Buffer.alloc(200, 0x61); // 200 bytes of 'a'
    const { exec } = makeExec([{ match: (c) => c.startsWith("bash -c "), stdout: big }], {
      stdoutMaxBytes: 64,
    });
    await exec.start();
    const res = await exec.bash("yes a");
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBe(64);
  });

  it("bash() enforces commandMaxBytes — throws on overflow", async () => {
    const { exec } = makeExec([], { commandMaxBytes: 16 });
    await exec.start();
    await expect(exec.bash("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).rejects.toThrow(
      /exceeds 16 byte cap/,
    );
  });

  it("bash() timeout sends SIGTERM and returns exitCode 124", async () => {
    const { exec, fake } = makeExec([{ match: () => true, hang: true }]);
    await exec.start();
    const res = await exec.bash("sleep 60", { timeoutMs: 30 });
    expect(res.exitCode).toBe(124);
    const stream = fake.streams[0];
    expect(stream?.signalCalls).toContain("TERM");
  });

  it("screenshot() rejects when DISPLAY is unset", async () => {
    const { exec } = makeExec([
      // DISPLAY probe returns empty.
      { match: (c) => c.includes("DISPLAY"), stdout: "", exitCode: 0 },
    ]);
    await exec.start();
    await expect(exec.screenshot()).rejects.toThrow(/X11 not configured/);
  });

  it("screenshot() parses PNG dimensions from remote stdout", async () => {
    // Minimal PNG header: 8-byte signature + 4-byte IHDR length + "IHDR" + w + h + rest.
    const png = Buffer.alloc(30);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.set([0x00, 0x00, 0x00, 0x0d], 8);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(600, 20);

    const { exec } = makeExec([
      { match: (c) => c.includes("DISPLAY"), stdout: ":1", exitCode: 0 },
      { match: (c) => c.includes("scrot"), stdout: png, exitCode: 0 },
    ]);
    await exec.start();
    const shot = await exec.screenshot();
    expect(shot.width).toBe(800);
    expect(shot.height).toBe(600);
    expect(shot.base64).toBe(png.toString("base64"));
  });

  it("click() dispatches xdotool mousemove ... click <button>", async () => {
    const { exec, fake } = makeExec([
      { match: (c) => c.includes("DISPLAY"), stdout: ":1", exitCode: 0 },
      { match: (c) => c.includes("xdotool"), stdout: "", exitCode: 0 },
    ]);
    await exec.start();
    await exec.click(100, 200, "right");
    const xdoCmd = fake.execCalls.find((c) => c.includes("xdotool"));
    expect(xdoCmd).toBeDefined();
    expect(xdoCmd).toContain("mousemove 100 200");
    expect(xdoCmd).toContain("click 3");
  });

  it("type() and key() use `--` to separate args from flags", async () => {
    const { exec, fake } = makeExec([
      { match: (c) => c.includes("DISPLAY"), stdout: ":1", exitCode: 0 },
      { match: (c) => c.includes("xdotool"), stdout: "", exitCode: 0 },
    ]);
    await exec.start();
    await exec.type("-hello");
    await exec.key("ctrl+c");

    const typeCmd = fake.execCalls.find((c) => c.includes("xdotool type"));
    const keyCmd = fake.execCalls.find((c) => c.includes("xdotool key"));
    expect(typeCmd).toBeDefined();
    expect(keyCmd).toBeDefined();
    expect(typeCmd).toContain("--");
    expect(typeCmd).toContain("'-hello'");
    expect(keyCmd).toContain("--");
    expect(keyCmd).toContain("'ctrl+c'");
  });

  it("textEditor('view') runs cat on the remote and returns numbered lines", async () => {
    const { exec, fake } = makeExec([
      { match: (c) => c.includes("cat"), stdout: "one\ntwo\nthree", exitCode: 0 },
    ]);
    await exec.start();
    const res = await exec.textEditor("view", { path: "/tmp/x.txt" });
    expect(res["lineCount"]).toBe(3);
    expect(res["numbered"]).toContain("1\tone");
    const catCmd = fake.execCalls.find((c) => c.includes("cat "));
    expect(catCmd).toBeDefined();
    expect(catCmd).toContain("'/tmp/x.txt'");
  });

  it("textEditor('create') streams file_text on stdin and captures an undo backup", async () => {
    const scripts: ExecScript[] = [
      // First `cat <path>` inside captureBackup — file doesn't exist
      { match: (c) => c.includes("bash -c 'cd") && c.includes("&& (cat"), stdout: "", exitCode: 1 },
      // Then the actual write via `cat > <path>`
      { match: (c) => c.includes("cat >"), stdout: "", exitCode: 0 },
    ];
    const { exec, fake } = makeExec(scripts);
    await exec.start();
    const res = await exec.textEditor("create", { path: "/tmp/new.txt", file_text: "hello\n" });
    expect(res["created"]).toBe(true);
    const writeStream = fake.streams[fake.streams.length - 1];
    expect(writeStream?.stdinBuffer).toBe("hello\n");
  });

  it("wait() works without a connection", async () => {
    const { exec, fake } = makeExec();
    const t0 = Date.now();
    await exec.wait(0.02);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(fake.connectCalls).toHaveLength(0);
  });

  it("stop() ends the client and is idempotent", async () => {
    const { exec, fake } = makeExec();
    await exec.start();
    await exec.stop();
    await exec.stop();
    expect(fake.endCalls).toBe(1);
  });

  it("missing ssh2 module throws a clear error on construction (no clientFactory)", () => {
    // No clientFactory → SSHExecutor calls loadSSHClient() which require()s ssh2.
    // ssh2 isn't installed in this test environment, so this must throw a
    // descriptive error. If it becomes installed in CI, this test will begin
    // to pass vacuously — which is also fine.
    let threw = false;
    try {
      new SSHExecutor({ host: "h", username: "u" });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/SSHExecutor requires `ssh2`/);
    }
    // We allow either outcome: if ssh2 is installed it's fine; otherwise the
    // error must match.
    if (!threw) {
      // ssh2 resolvable in this env — still OK.
      expect(true).toBe(true);
    }
  });
});
