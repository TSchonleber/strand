/**
 * SSHExecutor — remote `ComputerExecutor` driven over SSH (ssh2 package).
 *
 * Mirrors the shape of DockerExecutor but targets a remote host. Enables
 * Strand's shell/git/fs tools to run on a cloud VM or lab box without the
 * operator shelling in themselves.
 *
 * Surface:
 *   • bash() + textEditor()           — fully supported
 *   • wait()                          — local setTimeout, no SSH
 *   • screenshot/click/key/type/...   — proxy xdotool + scrot over bash; only
 *                                       meaningful when X11 forwarding is
 *                                       configured on the remote host. Fail
 *                                       loudly when DISPLAY is unset.
 *
 * Safety posture mirrors DockerExecutor: `safe=false` until the operator
 * calls `markSafe()`. Operator's attestation that the remote host has no
 * production secrets, the SSH key is scoped appropriately, etc.
 *
 * Security notes:
 *   • Every user-controlled string that ends up in a remote command is
 *     POSIX-single-quoted via `shellQuote`. ssh2.Client.exec takes one
 *     string — there is no argv array — so quoting is load-bearing.
 *   • Host-key verification: pin via `hostKeyFingerprint` (SHA256:<base64>).
 *     If omitted, first-connect acceptance logs a loud warn. Not prod-safe.
 *   • Writes use `cat > <path>` with content streamed on stdin — no heredoc,
 *     no quoting landmines for file contents.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { log } from "@/util/log";
import type {
  BashResult,
  ComputerExecutor,
  MouseButton,
  Screenshot,
  ScrollDirection,
  TextEditorCommand,
} from "./executor";

// ─── ssh2 client surface (minimum subset we use) ────────────────────────────

/**
 * Handler for the `data` and `close` events. Kept loose (`unknown[]`) so
 * fakes can be plain EventEmitters without type contortions.
 */
type EventHandler = (...args: unknown[]) => void;

export interface SSHStreamLike {
  on(event: "data", cb: (chunk: Buffer) => void): this;
  on(event: "close", cb: (code: number | null, signal?: string | null) => void): this;
  on(event: string, cb: EventHandler): this;
  /** stderr is a separate Readable on the exec stream. */
  stderr: {
    on(event: "data", cb: (chunk: Buffer) => void): unknown;
  };
  /** Best-effort — many servers ignore signals over SSH. */
  signal?(name: string): void;
  end?(input?: string | Buffer): void;
  close?(): void;
  /** Stdin for writes. */
  write?(chunk: string | Buffer): boolean;
}

export interface SSHConnectConfig {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  readyTimeout?: number;
  /** ssh2 host-key verifier. Return true to accept. */
  hostVerifier?: (keyBuf: Buffer) => boolean;
}

export interface SSHClientLike {
  connect(config: SSHConnectConfig): void;
  on(event: "ready", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  on(event: "close", cb: () => void): this;
  on(event: string, cb: EventHandler): this;
  off?(event: string, cb: EventHandler): this;
  exec(command: string, cb: (err: Error | undefined, stream: SSHStreamLike) => void): void;
  end(): void;
}

// ─── config + defaults ──────────────────────────────────────────────────────

export interface SSHExecutorConfig {
  host: string;
  port?: number;
  username: string;
  /** Private key contents (PEM/OpenSSH). Prefer `privateKeyPath` + CredentialStore. */
  privateKey?: string;
  /** Path to a key file; read at start(). */
  privateKeyPath?: string;
  /** Key passphrase. */
  passphrase?: string;
  /** Password auth — discouraged, keys preferred. */
  password?: string;
  /** Working directory for bash(). Default: "~" (user's home). */
  cwd?: string;
  /** Max stdout bytes retained per command. Default: 65536. */
  stdoutMaxBytes?: number;
  /** Max command length (UTF-8 bytes). Default: 16384. */
  commandMaxBytes?: number;
  /** Default per-op timeout in ms. Default: 30_000. */
  defaultTimeoutMs?: number;
  /** ssh2 `readyTimeout`. Default: 15_000. */
  readyTimeoutMs?: number;
  /**
   * Pin the remote host key — format `SHA256:<base64>` (matches
   * `ssh-keygen -lf`). When omitted, first-connect is accepted with a loud
   * warning. NOT prod-safe.
   */
  hostKeyFingerprint?: string;
  /** Inject a client factory (tests). Defaults to lazy-require'd `new ssh2.Client()`. */
  clientFactory?: () => SSHClientLike;
}

const DEFAULT_PORT = 22;
const DEFAULT_STDOUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_CWD = "~";

// ─── helpers ────────────────────────────────────────────────────────────────

/** POSIX-safe single-quote wrap — only trusted way to embed user input. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buttonNum(button: MouseButton): 1 | 2 | 3 {
  switch (button) {
    case "left":
      return 1;
    case "middle":
      return 2;
    case "right":
      return 3;
  }
}

function scrollButtonNum(dir: ScrollDirection): 4 | 5 | 6 | 7 {
  switch (dir) {
    case "up":
      return 4;
    case "down":
      return 5;
    case "left":
      return 6;
    case "right":
      return 7;
  }
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  ) {
    return null;
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** `SHA256:<base64>` comparison, matching `ssh-keygen -lf` output. */
function verifyHostKey(keyBuf: Buffer, expected: string): boolean {
  const want = expected.startsWith("SHA256:") ? expected.slice(7) : expected;
  // ssh-keygen uses unpadded base64.
  const got = createHash("sha256").update(keyBuf).digest("base64").replace(/=+$/, "");
  return got === want.replace(/=+$/, "");
}

function loadSSHClient(): () => SSHClientLike {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: module boundary — no types
    const req: (id: string) => any = Function("id", "return require(id)") as never;
    const mod = req("ssh2");
    const Client: { new (): SSHClientLike } | undefined = mod?.Client;
    if (!Client) {
      throw new Error("ssh2 module loaded but did not expose `Client`");
    }
    return () => new Client();
  } catch (err) {
    throw new Error(
      `SSHExecutor requires \`ssh2\`. Install with: pnpm add ssh2 @types/ssh2\n(original error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

// ─── SSHExecutor ────────────────────────────────────────────────────────────

interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  truncated: boolean;
}

export class SSHExecutor implements ComputerExecutor {
  readonly name = "ssh";
  private _safe = false;

  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly cwd: string;
  readonly stdoutMaxBytes: number;
  readonly commandMaxBytes: number;
  readonly defaultTimeoutMs: number;
  readonly readyTimeoutMs: number;

  private readonly clientFactory: () => SSHClientLike;
  private client: SSHClientLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private undoBackups = new Map<string, string>();

  constructor(public readonly config: SSHExecutorConfig) {
    if (!config.host || !config.username) {
      throw new Error("SSHExecutor: `host` and `username` are required");
    }
    this.host = config.host;
    this.port = config.port ?? DEFAULT_PORT;
    this.username = config.username;
    this.cwd = config.cwd ?? DEFAULT_CWD;
    this.stdoutMaxBytes = config.stdoutMaxBytes ?? DEFAULT_STDOUT_BYTES;
    this.commandMaxBytes = config.commandMaxBytes ?? DEFAULT_COMMAND_BYTES;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.clientFactory = config.clientFactory ?? loadSSHClient();
  }

  get safe(): boolean {
    return this._safe;
  }

  /** Operator assertion that the remote host is isolated + SSH key is scoped. */
  markSafe(): void {
    this._safe = true;
    log.info({ svc: "exec", exec: this.name, op: "markSafe" }, "exec.ssh");
  }

  private logOp(op: string, args: Record<string, unknown>): void {
    log.info(
      { svc: "exec", exec: this.name, op, host: this.host, port: this.port, args },
      "exec.ssh",
    );
  }

  // ── lifecycle ───────────────────────────────────────────

  /** Establish (or re-use) the SSH connection. Idempotent across concurrent callers. */
  async start(): Promise<void> {
    if (this.client) return;
    if (this.connectPromise) return this.connectPromise;

    const promise = this.doConnect().catch((err) => {
      this.connectPromise = null;
      this.client = null;
      throw err;
    });
    this.connectPromise = promise;
    await promise;
  }

  private async doConnect(): Promise<void> {
    this.logOp("start", {});

    let privateKey: Buffer | string | undefined = this.config.privateKey;
    if (!privateKey && this.config.privateKeyPath) {
      privateKey = await readFile(this.config.privateKeyPath);
    }

    const client = this.clientFactory();
    const fingerprint = this.config.hostKeyFingerprint;

    const connectOpts: SSHConnectConfig = {
      host: this.host,
      port: this.port,
      username: this.username,
      readyTimeout: this.readyTimeoutMs,
    };
    if (privateKey !== undefined) {
      connectOpts.privateKey = privateKey;
    }
    if (this.config.passphrase !== undefined) {
      connectOpts.passphrase = this.config.passphrase;
    }
    if (this.config.password !== undefined) {
      connectOpts.password = this.config.password;
    }
    if (fingerprint) {
      connectOpts.hostVerifier = (keyBuf: Buffer) => verifyHostKey(keyBuf, fingerprint);
    } else {
      log.warn(
        { svc: "exec", exec: this.name, host: this.host },
        "exec.ssh.no_host_key_pin — accepting any host key (NOT production-safe)",
      );
      connectOpts.hostVerifier = () => true;
    }

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`SSH connect failed (${this.host}:${this.port}): ${err.message}`));
      };
      const cleanup = () => {
        if (client.off) {
          client.off("ready", onReady as EventHandler);
          client.off("error", onError as EventHandler);
        }
      };
      client.on("ready", onReady);
      client.on("error", onError);
      client.connect(connectOpts);
    });

    // Unwire the fatal-error handler; install a benign one so further errors
    // don't crash the event loop.
    client.on("error", (err) => {
      log.warn({ svc: "exec", exec: this.name, err: String(err) }, "exec.ssh.runtime_error");
    });
    client.on("close", () => {
      log.info({ svc: "exec", exec: this.name }, "exec.ssh.closed");
      this.client = null;
    });

    this.client = client;
  }

  /** Close the connection. Idempotent. */
  async stop(): Promise<void> {
    this.logOp("stop", {});
    const c = this.client;
    this.client = null;
    this.connectPromise = null;
    if (c) {
      try {
        c.end();
      } catch (err) {
        log.warn({ svc: "exec", exec: this.name, err: String(err) }, "exec.ssh.stop_error");
      }
    }
  }

  private async ensureConnected(): Promise<SSHClientLike> {
    if (!this.client) await this.start();
    if (!this.client) {
      throw new Error("SSHExecutor: not connected after start()");
    }
    return this.client;
  }

  // ── core exec primitive ─────────────────────────────────

  /**
   * Run a raw command string on the remote over `exec`. Streams stdout/stderr,
   * truncates at `stdoutMaxBytes`, enforces timeout via `signal("TERM")` +
   * `close()` as fallback. Resolves with `exitCode: 124` on timeout (no
   * rejection), matching conventional timeout semantics.
   */
  private async remoteExec(
    command: string,
    opts: { timeoutMs?: number; stdin?: string | Buffer } = {},
  ): Promise<ExecResult> {
    const client = await this.ensureConnected();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        let settled = false;
        let timedOut = false;

        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                if (settled) return;
                timedOut = true;
                try {
                  stream.signal?.("TERM");
                } catch {
                  /* server may not support signals */
                }
                try {
                  stream.close?.();
                } catch {
                  /* best-effort */
                }
                try {
                  stream.end?.();
                } catch {
                  /* best-effort */
                }
                // Fallback: if `close` never fires, settle on our own.
                setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  resolve({
                    stdout: Buffer.concat(stdoutChunks),
                    stderr: Buffer.concat(stderrChunks),
                    exitCode: 124,
                    truncated,
                  });
                }, 50);
              }, timeoutMs)
            : null;

        stream.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= this.stdoutMaxBytes) {
            stdoutChunks.push(chunk);
          } else {
            if (!truncated) {
              // Trim to exactly the cap.
              const already = stdoutBytes - chunk.length;
              const keep = this.stdoutMaxBytes - already;
              if (keep > 0) stdoutChunks.push(chunk.subarray(0, keep));
            }
            truncated = true;
          }
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes <= this.stdoutMaxBytes) {
            stderrChunks.push(chunk);
          } else {
            if (!truncated) {
              const already = stderrBytes - chunk.length;
              const keep = this.stdoutMaxBytes - already;
              if (keep > 0) stderrChunks.push(chunk.subarray(0, keep));
            }
            truncated = true;
          }
        });
        stream.on("close", (code: number | null, signal?: string | null) => {
          if (timer) clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (timedOut) {
            resolve({
              stdout: Buffer.concat(stdoutChunks),
              stderr: Buffer.concat(stderrChunks),
              exitCode: 124,
              truncated,
            });
            return;
          }
          const exitCode = typeof code === "number" ? code : signal ? 128 : 0;
          resolve({
            stdout: Buffer.concat(stdoutChunks),
            stderr: Buffer.concat(stderrChunks),
            exitCode,
            truncated,
          });
        });

        if (opts.stdin !== undefined) {
          stream.write?.(opts.stdin);
          stream.end?.();
        }
      });
    });
  }

  // ── shell ───────────────────────────────────────────────

  async bash(
    command: string,
    opts: { timeoutMs?: number; cwd?: string } = {},
  ): Promise<BashResult> {
    this.logOp("bash", { commandLength: command.length });
    const bytes = Buffer.byteLength(command, "utf8");
    if (bytes > this.commandMaxBytes) {
      throw new Error(`bash: command exceeds ${this.commandMaxBytes} byte cap (got ${bytes})`);
    }

    const cwd = opts.cwd ?? this.cwd;
    const wrapped = cwd ? `cd ${shellQuote(cwd)} && (${command})` : command;
    const full = `bash -c ${shellQuote(wrapped)}`;

    const execOpts: { timeoutMs?: number } = {};
    if (opts.timeoutMs !== undefined) execOpts.timeoutMs = opts.timeoutMs;
    const res = await this.remoteExec(full, execOpts);
    const out: BashResult = {
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr.toString("utf8"),
      exitCode: res.exitCode,
    };
    if (res.truncated) out.truncated = true;
    return out;
  }

  // ── display / X11 proxies ───────────────────────────────

  /** Runs a bash one-liner and throws on non-zero exit. Used by X11 proxies. */
  private async bashOrThrow(op: string, command: string): Promise<string> {
    const res = await this.bash(command);
    if (res.exitCode !== 0) {
      throw new Error(`${op} failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout}`);
    }
    return res.stdout;
  }

  private async assertX11(op: string): Promise<void> {
    const res = await this.bash('printf "%s" "${DISPLAY:-}"');
    if (res.exitCode !== 0 || res.stdout.length === 0) {
      throw new Error(
        `${op}: X11 not configured on ${this.host} (DISPLAY unset). Set up X11 forwarding or an Xvfb server before using desktop actions.`,
      );
    }
  }

  async screenshot(): Promise<Screenshot> {
    this.logOp("screenshot", {});
    await this.assertX11("screenshot");
    // scrot -o /dev/stdout → PNG on stdout. Use a temp file to avoid binary
    // mangling in bash's output processing? No — scrot writes raw, and our
    // stream buffer is binary-safe.
    const res = await this.remoteExec(`bash -c ${shellQuote("scrot -o /dev/stdout")}`);
    if (res.exitCode !== 0) {
      throw new Error(`screenshot failed: ${res.stderr.toString("utf8").trim()}`);
    }
    const dims = parsePngDimensions(res.stdout);
    if (!dims) {
      throw new Error("screenshot: scrot output is not a PNG");
    }
    return {
      base64: res.stdout.toString("base64"),
      width: dims.width,
      height: dims.height,
    };
  }

  async cursorPosition(): Promise<{ x: number; y: number }> {
    this.logOp("cursorPosition", {});
    await this.assertX11("cursorPosition");
    const out = await this.bashOrThrow("cursorPosition", "xdotool getmouselocation --shell");
    const x = /^X=(\d+)/m.exec(out);
    const y = /^Y=(\d+)/m.exec(out);
    if (!x || !y) {
      throw new Error(`cursorPosition: unparseable output: ${out}`);
    }
    return { x: Number(x[1]), y: Number(y[1]) };
  }

  // ── mouse ────────────────────────────────────────────────

  async mouseMove(x: number, y: number): Promise<void> {
    this.logOp("mouseMove", { x, y });
    await this.assertX11("mouseMove");
    await this.bashOrThrow("mouseMove", `xdotool mousemove ${Number(x)} ${Number(y)}`);
  }

  async click(x: number, y: number, button: MouseButton = "left"): Promise<void> {
    this.logOp("click", { x, y, button });
    await this.assertX11("click");
    await this.bashOrThrow(
      "click",
      `xdotool mousemove ${Number(x)} ${Number(y)} click ${buttonNum(button)}`,
    );
  }

  async doubleClick(x: number, y: number, button: MouseButton = "left"): Promise<void> {
    this.logOp("doubleClick", { x, y, button });
    await this.assertX11("doubleClick");
    await this.bashOrThrow(
      "doubleClick",
      `xdotool mousemove ${Number(x)} ${Number(y)} click --repeat 2 ${buttonNum(button)}`,
    );
  }

  async mouseDown(button: MouseButton = "left"): Promise<void> {
    this.logOp("mouseDown", { button });
    await this.assertX11("mouseDown");
    await this.bashOrThrow("mouseDown", `xdotool mousedown ${buttonNum(button)}`);
  }

  async mouseUp(button: MouseButton = "left"): Promise<void> {
    this.logOp("mouseUp", { button });
    await this.assertX11("mouseUp");
    await this.bashOrThrow("mouseUp", `xdotool mouseup ${buttonNum(button)}`);
  }

  async scroll(direction: ScrollDirection, amount: number): Promise<void> {
    this.logOp("scroll", { direction, amount });
    await this.assertX11("scroll");
    const clicks = Math.max(1, Math.floor(amount));
    await this.bashOrThrow(
      "scroll",
      `xdotool click --repeat ${clicks} ${scrollButtonNum(direction)}`,
    );
  }

  // ── keyboard ─────────────────────────────────────────────

  async key(keys: string): Promise<void> {
    this.logOp("key", { keys });
    await this.assertX11("key");
    // `--` terminates option parsing so a key starting with "-" is safe.
    await this.bashOrThrow("key", `xdotool key -- ${shellQuote(keys)}`);
  }

  async type(text: string): Promise<void> {
    this.logOp("type", { textLength: text.length });
    await this.assertX11("type");
    await this.bashOrThrow("type", `xdotool type --delay 40 -- ${shellQuote(text)}`);
  }

  // ── timing ───────────────────────────────────────────────

  async wait(seconds: number): Promise<void> {
    this.logOp("wait", { seconds });
    await new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
  }

  // ── text editor ──────────────────────────────────────────

  async textEditor(
    command: TextEditorCommand,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.logOp("textEditor", { command, path: args["path"] });

    const path = typeof args["path"] === "string" ? args["path"] : "";
    if (!path && command !== "undo_edit") {
      throw new Error(`textEditor.${command}: "path" arg is required`);
    }

    switch (command) {
      case "view":
        return this.teView(path);
      case "create": {
        const content = typeof args["file_text"] === "string" ? args["file_text"] : "";
        return this.teCreate(path, content);
      }
      case "str_replace": {
        const oldStr = typeof args["old_str"] === "string" ? args["old_str"] : "";
        const newStr = typeof args["new_str"] === "string" ? args["new_str"] : "";
        return this.teStrReplace(path, oldStr, newStr);
      }
      case "insert": {
        const insertLine = typeof args["insert_line"] === "number" ? args["insert_line"] : 0;
        const newStr = typeof args["new_str"] === "string" ? args["new_str"] : "";
        return this.teInsert(path, insertLine, newStr);
      }
      case "undo_edit":
        return this.teUndo(path);
      default:
        throw new Error(`textEditor: unsupported command: ${command satisfies never}`);
    }
  }

  private async teView(path: string): Promise<Record<string, unknown>> {
    const res = await this.bash(`cat ${shellQuote(path)}`);
    if (res.exitCode !== 0) {
      throw new Error(`view failed: ${res.stderr.trim()}`);
    }
    const content = res.stdout;
    const lines = content.split("\n");
    const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
    return { path, content, numbered, lineCount: lines.length };
  }

  private async teCreate(path: string, content: string): Promise<Record<string, unknown>> {
    await this.captureBackup(path);
    await this.writeFile(path, content);
    return { path, created: true, bytes: Buffer.byteLength(content, "utf8") };
  }

  private async teStrReplace(
    path: string,
    oldStr: string,
    newStr: string,
  ): Promise<Record<string, unknown>> {
    const cur = await this.bash(`cat ${shellQuote(path)}`);
    if (cur.exitCode !== 0) {
      throw new Error(`str_replace: cannot read ${path}: ${cur.stderr.trim()}`);
    }
    const current = cur.stdout;
    const first = current.indexOf(oldStr);
    if (first === -1) {
      throw new Error(`str_replace: old_str not found in ${path}`);
    }
    const second = current.indexOf(oldStr, first + 1);
    if (second !== -1) {
      throw new Error(`str_replace: old_str appears more than once in ${path}`);
    }
    this.undoBackups.set(path, current);
    const next = current.slice(0, first) + newStr + current.slice(first + oldStr.length);
    await this.writeFile(path, next);
    return { path, replaced: true };
  }

  private async teInsert(
    path: string,
    insertLine: number,
    newStr: string,
  ): Promise<Record<string, unknown>> {
    const cur = await this.bash(`cat ${shellQuote(path)}`);
    if (cur.exitCode !== 0) {
      throw new Error(`insert: cannot read ${path}: ${cur.stderr.trim()}`);
    }
    const current = cur.stdout;
    const lines = current.split("\n");
    const clamped = Math.max(0, Math.min(insertLine, lines.length));
    const before = lines.slice(0, clamped);
    const after = lines.slice(clamped);
    const inserted = [...before, newStr, ...after].join("\n");
    this.undoBackups.set(path, current);
    await this.writeFile(path, inserted);
    return { path, inserted: true, at: clamped };
  }

  private async teUndo(path: string): Promise<Record<string, unknown>> {
    const backup = this.undoBackups.get(path);
    if (backup === undefined) {
      throw new Error(`undo_edit: no backup for ${path}`);
    }
    await this.writeFile(path, backup);
    this.undoBackups.delete(path);
    return { path, restored: true };
  }

  private async captureBackup(path: string): Promise<void> {
    const res = await this.bash(`cat ${shellQuote(path)}`);
    if (res.exitCode === 0) {
      this.undoBackups.set(path, res.stdout);
    }
  }

  /**
   * Write a file on the remote by streaming content into `cat > <path>`.
   * Content goes over stdin — never interpolated into the shell, so embedded
   * quotes, backticks, and heredoc terminators are all safe.
   */
  private async writeFile(path: string, content: string): Promise<void> {
    const cmd = `bash -c ${shellQuote(`cat > ${shellQuote(path)}`)}`;
    const res = await this.remoteExec(cmd, { stdin: content });
    if (res.exitCode !== 0) {
      throw new Error(
        `write ${path} failed (exit ${res.exitCode}): ${res.stderr.toString("utf8")}`,
      );
    }
  }
}
