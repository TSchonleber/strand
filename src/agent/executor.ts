/**
 * ComputerExecutor — side-effects host for desktop/computer-use tool calls.
 *
 * The LLM says what to do (via provider-native computer-use tool calls); the
 * agentic loop invokes the executor to actually perform the action. Separate
 * concerns: provider adapters handle the wire format; executors handle the
 * sandbox + side effects.
 *
 * Safety posture:
 *   • NoopExecutor (default): logs the intended action, returns canned state.
 *     Safe for shadow mode, evals, and agent-behavior dev.
 *   • DockerExecutor: real sandbox. Runs Xvfb + fluxbox + x11vnc in a
 *     container, drives the display via xdotool/scrot. Every operation is
 *     logged and argv-escaped. Marked `safe=false` until the operator calls
 *     `markSafe()` — callers that gate on `safe` refuse to run until then.
 *
 * Never default to host-direct execution. The user must opt in explicitly
 * with a host backend + per-action human approval in Phase 0–6.
 */

import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { log } from "@/util/log";

export interface Screenshot {
  base64: string;
  width: number;
  height: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
}

export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";

export type TextEditorCommand = "view" | "create" | "str_replace" | "insert" | "undo_edit";

export interface ComputerExecutor {
  /** Short name for telemetry — "noop", "docker", "host", etc. */
  readonly name: string;

  /**
   * Whether this executor is safe to run in gated/live mode. NoopExecutor → true
   * (never does anything). Real executors default false until explicitly
   * marked safe by their config.
   */
  readonly safe: boolean;

  // ─── display ──────────────────────────────────────────────
  screenshot(): Promise<Screenshot>;
  cursorPosition(): Promise<{ x: number; y: number }>;

  // ─── mouse ────────────────────────────────────────────────
  mouseMove(x: number, y: number): Promise<void>;
  click(x: number, y: number, button?: MouseButton): Promise<void>;
  doubleClick(x: number, y: number, button?: MouseButton): Promise<void>;
  mouseDown(button?: MouseButton): Promise<void>;
  mouseUp(button?: MouseButton): Promise<void>;
  scroll(direction: ScrollDirection, amount: number): Promise<void>;

  // ─── keyboard ─────────────────────────────────────────────
  key(keys: string): Promise<void>;
  type(text: string): Promise<void>;

  // ─── timing ───────────────────────────────────────────────
  wait(seconds: number): Promise<void>;

  // ─── shell (Anthropic bash_20250124) ──────────────────────
  bash(command: string, opts?: { timeoutMs?: number; cwd?: string }): Promise<BashResult>;

  // ─── text editor (Anthropic text_editor_20250124) ─────────
  textEditor(
    command: TextEditorCommand,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/**
 * Shadow-mode executor. Logs intent, returns canned empty state. Does NOT
 * touch the host. This is the default for every environment unless the
 * operator plugs in a real executor.
 */
export class NoopExecutor implements ComputerExecutor {
  readonly name = "noop";
  readonly safe = true;

  async screenshot(): Promise<Screenshot> {
    log.info({ svc: "exec", exec: this.name, op: "screenshot" }, "exec.noop");
    // 1x1 transparent PNG.
    return {
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      width: 1,
      height: 1,
    };
  }

  async cursorPosition(): Promise<{ x: number; y: number }> {
    log.info({ svc: "exec", exec: this.name, op: "cursorPosition" }, "exec.noop");
    return { x: 0, y: 0 };
  }

  async mouseMove(x: number, y: number): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "mouseMove", x, y }, "exec.noop");
  }

  async click(x: number, y: number, button: MouseButton = "left"): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "click", x, y, button }, "exec.noop");
  }

  async doubleClick(x: number, y: number, button: MouseButton = "left"): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "doubleClick", x, y, button }, "exec.noop");
  }

  async mouseDown(button: MouseButton = "left"): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "mouseDown", button }, "exec.noop");
  }

  async mouseUp(button: MouseButton = "left"): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "mouseUp", button }, "exec.noop");
  }

  async scroll(direction: ScrollDirection, amount: number): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "scroll", direction, amount }, "exec.noop");
  }

  async key(keys: string): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "key", keys }, "exec.noop");
  }

  async type(text: string): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "type", textLength: text.length }, "exec.noop");
  }

  async wait(seconds: number): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "wait", seconds }, "exec.noop");
  }

  async bash(command: string, _opts?: { timeoutMs?: number; cwd?: string }): Promise<BashResult> {
    log.info({ svc: "exec", exec: this.name, op: "bash", command }, "exec.noop");
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async textEditor(
    command: TextEditorCommand,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    log.info({ svc: "exec", exec: this.name, op: "textEditor", command, args }, "exec.noop");
    return { ok: true, noop: true };
  }
}

// ─── DockerExecutor ────────────────────────────────────────────────────────

/**
 * Result of a single child process invocation. Matches what `execFile`
 * produces, plus an exit code for non-throwing error paths (timeout, non-zero
 * exit when we opt not to throw).
 */
export interface DockerExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/**
 * Pluggable child-process runner. Tests inject a fake; production uses the
 * real `execFile`. Everything goes through this, including `docker exec`
 * lookups and `docker inspect` for liveness checks.
 *
 * Contract:
 *   • MUST treat `args` as argv (no shell interpolation).
 *   • MUST resolve with the final buffers + exitCode; rejection is for
 *     spawn-failure / signal-kill / timeout.
 *   • timeoutMs=0 means no timeout.
 *   • maxBuffer caps stdout/stderr at the given bytes — over that, the
 *     runner should truncate (prefer) or reject with code "ERR_OUT_OF_RANGE".
 */
export type DockerExecFn = (
  file: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; maxBuffer?: number; input?: string },
) => Promise<DockerExecResult>;

export interface DockerExecutorConfig {
  /** Sandbox image tag. Default: "strand-sandbox:latest". */
  image?: string;
  /** Name used on `docker run --name` and for every `docker exec`. */
  containerName?: string;
  /** X display passed as `-e DISPLAY=...`. Default: ":1". */
  display?: string;
  /** Optional path bind-mounted at /workdir. */
  workdir?: string;
  /** Docker socket override (rare). */
  socketPath?: string;
  /** Pull + start the container lazily on first action. Default: false. */
  autoStart?: boolean;
  /** Default per-op timeout, ms. Default: 30_000. */
  defaultTimeoutMs?: number;
  /** Dependency injection for tests / alternate transports. */
  execFile?: DockerExecFn;
}

/** Hard caps. */
const BASH_MAX_STDOUT_BYTES = 64 * 1024;
const BASH_MAX_COMMAND_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IMAGE = "strand-sandbox:latest";
const DEFAULT_CONTAINER = "strand-sandbox";
const DEFAULT_DISPLAY = ":1";

/**
 * Default runner. Uses `spawn` under the hood so we can stream stdin (for
 * textEditor writes) and collect binary stdout (for screenshots) without
 * execFile's string-first defaults.
 */
const defaultExecFile: DockerExecFn = (file, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;

  return new Promise<DockerExecResult>((resolve, reject) => {
    if (opts.input === undefined) {
      // Simple path: execFile with buffer encoding.
      nodeExecFile(
        file,
        [...args],
        {
          timeout: timeoutMs > 0 ? timeoutMs : 0,
          maxBuffer,
          encoding: "buffer",
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & {
              code?: number | string;
            };
            // execFile error objects carry stdout/stderr; process.exitCode
            // lives on `code` when non-zero.
            if (stdout !== undefined || stderr !== undefined) {
              const exitCode = typeof e.code === "number" ? e.code : 1;
              resolve({
                stdout: (stdout as Buffer) ?? Buffer.alloc(0),
                stderr: (stderr as Buffer) ?? Buffer.alloc(0),
                exitCode,
              });
              return;
            }
            reject(err);
            return;
          }
          resolve({
            stdout: stdout as Buffer,
            stderr: stderr as Buffer,
            exitCode: 0,
          });
        },
      );
      return;
    }

    // Stdin path.
    const child = nodeSpawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderrChunks.push(chunk);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        reject(new Error(`command timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        exitCode: code ?? (signal ? 1 : 0),
      });
    });

    child.stdin.end(opts.input);
  });
};

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

/**
 * Parse PNG IHDR to pull width + height. PNG header layout:
 *   0..7   — signature (\x89PNG\r\n\x1a\n)
 *   8..11  — IHDR length (always 13)
 *  12..15  — "IHDR"
 *  16..19  — width (u32 big-endian)
 *  20..23  — height (u32 big-endian)
 * Returns null if the buffer does not look like a PNG.
 */
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
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/**
 * Docker-sandboxed executor.
 *
 * Architecture: a long-running container with Xvfb + fluxbox + x11vnc; this
 * class shells out to `docker exec` for every action. No shell interpolation
 * — args go through `execFile` as argv arrays.
 */
export class DockerExecutor implements ComputerExecutor {
  readonly name = "docker";
  private _safe = false;

  readonly image: string;
  readonly containerName: string;
  readonly display: string;
  readonly workdir: string | undefined;
  readonly socketPath: string | undefined;
  readonly autoStart: boolean;
  readonly defaultTimeoutMs: number;

  private readonly execFile: DockerExecFn;
  private started = false;
  private undoBackups = new Map<string, string>();

  constructor(public readonly config: DockerExecutorConfig = {}) {
    this.image = config.image ?? DEFAULT_IMAGE;
    this.containerName = config.containerName ?? DEFAULT_CONTAINER;
    this.display = config.display ?? DEFAULT_DISPLAY;
    this.workdir = config.workdir;
    this.socketPath = config.socketPath;
    this.autoStart = config.autoStart ?? false;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.execFile = config.execFile ?? defaultExecFile;
  }

  get safe(): boolean {
    return this._safe;
  }

  /**
   * Operator assertion that the container is properly isolated (no secrets
   * mounted, no host network, bounded FS). Without this, policy gating on
   * `.safe` keeps the executor out of gated/live modes.
   */
  markSafe(): void {
    this._safe = true;
    log.info({ svc: "exec", exec: this.name, op: "markSafe" }, "exec.docker");
  }

  // ── lifecycle ────────────────────────────────────────────

  private dockerGlobalArgs(): string[] {
    return this.socketPath ? ["-H", `unix://${this.socketPath}`] : [];
  }

  private async runDocker(
    args: readonly string[],
    opts: { timeoutMs?: number; maxBuffer?: number } = {},
  ): Promise<DockerExecResult> {
    return this.execFile("docker", [...this.dockerGlobalArgs(), ...args], {
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
    });
  }

  private async execIn(
    argv: readonly string[],
    opts: { timeoutMs?: number; maxBuffer?: number; extraDockerArgs?: readonly string[] } = {},
  ): Promise<DockerExecResult> {
    const dockerArgs = [
      "exec",
      "-e",
      `DISPLAY=${this.display}`,
      ...(opts.extraDockerArgs ?? []),
      this.containerName,
      ...argv,
    ];
    return this.runDocker(dockerArgs, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
    });
  }

  /** Pull + run the sandbox container. No-op if already started. */
  async start(): Promise<void> {
    if (this.started) return;
    log.info(
      {
        svc: "exec",
        exec: this.name,
        op: "start",
        image: this.image,
        container: this.containerName,
      },
      "exec.docker",
    );

    // Best-effort pull. Don't fail start() if the image is already local.
    try {
      await this.runDocker(["pull", this.image], { timeoutMs: 5 * 60_000 });
    } catch (err) {
      log.warn({ svc: "exec", exec: this.name, op: "start.pull", err: String(err) }, "exec.docker");
    }

    const runArgs = [
      "run",
      "-d",
      "--rm",
      "--name",
      this.containerName,
      "-e",
      `DISPLAY=${this.display}`,
    ];
    if (this.workdir) {
      runArgs.push("-v", `${this.workdir}:/workdir`);
    }
    runArgs.push(this.image);

    const res = await this.runDocker(runArgs);
    if (res.exitCode !== 0) {
      throw new Error(
        `docker run failed (exit ${res.exitCode}): ${res.stderr.toString("utf8").trim()}`,
      );
    }
    this.started = true;
  }

  /** Stop the container (honors --rm from start()). No-op if not running. */
  async stop(): Promise<void> {
    log.info(
      { svc: "exec", exec: this.name, op: "stop", container: this.containerName },
      "exec.docker",
    );
    try {
      await this.runDocker(["stop", this.containerName], { timeoutMs: 30_000 });
    } finally {
      this.started = false;
    }
  }

  /** Query docker to confirm the container is actually running. */
  private async isRunning(): Promise<boolean> {
    try {
      const res = await this.runDocker(["inspect", "-f", "{{.State.Running}}", this.containerName]);
      if (res.exitCode !== 0) return false;
      return res.stdout.toString("utf8").trim() === "true";
    } catch {
      return false;
    }
  }

  private async ensureRunning(): Promise<void> {
    if (this.started && (await this.isRunning())) return;
    if (this.autoStart) {
      await this.start();
      return;
    }
    const running = await this.isRunning();
    if (running) {
      this.started = true;
      return;
    }
    throw new Error(
      `DockerExecutor: container "${this.containerName}" is not running. Call .start() first, or construct with { autoStart: true }.`,
    );
  }

  private logOp(op: string, args: Record<string, unknown>): void {
    log.info({ svc: "exec", exec: this.name, op, args }, "exec.docker");
  }

  // ── display ──────────────────────────────────────────────

  async screenshot(): Promise<Screenshot> {
    this.logOp("screenshot", {});
    await this.ensureRunning();
    // `scrot -o /dev/stdout` → PNG bytes on stdout. Use bash -c so the path
    // is evaluated inside the container (no host shell).
    const res = await this.execIn(["scrot", "-o", "/dev/stdout"], {
      maxBuffer: 32 * 1024 * 1024, // 32MB — a 1280x800 PNG is ~1-3MB.
    });
    if (res.exitCode !== 0) {
      throw new Error(`screenshot failed: ${res.stderr.toString("utf8").trim()}`);
    }
    const buf = res.stdout;
    const dims = parsePngDimensions(buf);
    if (!dims) {
      throw new Error("screenshot: scrot output is not a PNG");
    }
    return {
      base64: buf.toString("base64"),
      width: dims.width,
      height: dims.height,
    };
  }

  async cursorPosition(): Promise<{ x: number; y: number }> {
    this.logOp("cursorPosition", {});
    await this.ensureRunning();
    const res = await this.execIn(["xdotool", "getmouselocation", "--shell"]);
    if (res.exitCode !== 0) {
      throw new Error(`cursorPosition failed: ${res.stderr.toString("utf8").trim()}`);
    }
    const out = res.stdout.toString("utf8");
    const xMatch = out.match(/^X=(\d+)/m);
    const yMatch = out.match(/^Y=(\d+)/m);
    if (!xMatch || !yMatch) {
      throw new Error(`cursorPosition: unparseable output: ${out}`);
    }
    return { x: Number(xMatch[1]), y: Number(yMatch[1]) };
  }

  // ── mouse ────────────────────────────────────────────────

  async mouseMove(x: number, y: number): Promise<void> {
    this.logOp("mouseMove", { x, y });
    await this.ensureRunning();
    await this.execIn(["xdotool", "mousemove", String(x), String(y)]);
  }

  async click(x: number, y: number, button: MouseButton = "left"): Promise<void> {
    this.logOp("click", { x, y, button });
    await this.ensureRunning();
    await this.execIn([
      "xdotool",
      "mousemove",
      String(x),
      String(y),
      "click",
      String(buttonNum(button)),
    ]);
  }

  async doubleClick(x: number, y: number, button: MouseButton = "left"): Promise<void> {
    this.logOp("doubleClick", { x, y, button });
    await this.ensureRunning();
    await this.execIn([
      "xdotool",
      "mousemove",
      String(x),
      String(y),
      "click",
      "--repeat",
      "2",
      String(buttonNum(button)),
    ]);
  }

  async mouseDown(button: MouseButton = "left"): Promise<void> {
    this.logOp("mouseDown", { button });
    await this.ensureRunning();
    await this.execIn(["xdotool", "mousedown", String(buttonNum(button))]);
  }

  async mouseUp(button: MouseButton = "left"): Promise<void> {
    this.logOp("mouseUp", { button });
    await this.ensureRunning();
    await this.execIn(["xdotool", "mouseup", String(buttonNum(button))]);
  }

  async scroll(direction: ScrollDirection, amount: number): Promise<void> {
    this.logOp("scroll", { direction, amount });
    await this.ensureRunning();
    const clicks = Math.max(1, Math.floor(amount));
    await this.execIn([
      "xdotool",
      "click",
      "--repeat",
      String(clicks),
      String(scrollButtonNum(direction)),
    ]);
  }

  // ── keyboard ─────────────────────────────────────────────

  async key(keys: string): Promise<void> {
    this.logOp("key", { keys });
    await this.ensureRunning();
    await this.execIn(["xdotool", "key", "--", keys]);
  }

  async type(text: string): Promise<void> {
    this.logOp("type", { textLength: text.length });
    await this.ensureRunning();
    // `--` terminates option parsing so text starting with "-" is safe.
    await this.execIn(["xdotool", "type", "--delay", "40", "--", text]);
  }

  // ── timing ───────────────────────────────────────────────

  async wait(seconds: number): Promise<void> {
    this.logOp("wait", { seconds });
    await new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
  }

  // ── shell ────────────────────────────────────────────────

  async bash(
    command: string,
    opts: { timeoutMs?: number; cwd?: string } = {},
  ): Promise<BashResult> {
    this.logOp("bash", { commandLength: command.length });
    if (Buffer.byteLength(command, "utf8") > BASH_MAX_COMMAND_BYTES) {
      throw new Error(`bash: command exceeds ${BASH_MAX_COMMAND_BYTES} byte cap`);
    }
    await this.ensureRunning();

    const wrapped = opts.cwd ? `cd ${shellQuote(opts.cwd)} && (${command})` : command;
    const res = await this.execIn(["bash", "-c", wrapped], {
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
      // Give ourselves a little headroom so we can detect truncation.
      maxBuffer: BASH_MAX_STDOUT_BYTES * 4,
    });

    let stdout = res.stdout.toString("utf8");
    const stderr = res.stderr.toString("utf8");
    let truncated = false;
    if (Buffer.byteLength(stdout, "utf8") > BASH_MAX_STDOUT_BYTES) {
      stdout = Buffer.from(stdout, "utf8").subarray(0, BASH_MAX_STDOUT_BYTES).toString("utf8");
      truncated = true;
    }
    return truncated
      ? { stdout, stderr, exitCode: res.exitCode, truncated: true }
      : { stdout, stderr, exitCode: res.exitCode };
  }

  // ── text editor (Anthropic text_editor_20250124) ─────────

  async textEditor(
    command: TextEditorCommand,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.logOp("textEditor", { command, path: args["path"] });
    await this.ensureRunning();

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
    const res = await this.execIn(["cat", path]);
    if (res.exitCode !== 0) {
      throw new Error(`view failed: ${res.stderr.toString("utf8").trim()}`);
    }
    const content = res.stdout.toString("utf8");
    const lines = content.split("\n");
    const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
    return { path, content, numbered, lineCount: lines.length };
  }

  private async teCreate(path: string, content: string): Promise<Record<string, unknown>> {
    // Back up whatever currently lives at `path` so undo_edit can restore.
    await this.captureBackup(path);
    // Write via stdin to avoid shell-interpolating content.
    const res = await this.writeFileViaTee(path, content);
    if (res.exitCode !== 0) {
      throw new Error(`create failed: ${res.stderr.toString("utf8").trim()}`);
    }
    return { path, created: true, bytes: Buffer.byteLength(content, "utf8") };
  }

  private async teStrReplace(
    path: string,
    oldStr: string,
    newStr: string,
  ): Promise<Record<string, unknown>> {
    const cur = await this.execIn(["cat", path]);
    if (cur.exitCode !== 0) {
      throw new Error(`str_replace: cannot read ${path}: ${cur.stderr.toString("utf8").trim()}`);
    }
    const current = cur.stdout.toString("utf8");
    const first = current.indexOf(oldStr);
    if (first === -1) {
      throw new Error(`str_replace: old_str not found in ${path}`);
    }
    const second = current.indexOf(oldStr, first + 1);
    if (second !== -1) {
      throw new Error(`str_replace: old_str appears more than once in ${path}`);
    }
    await this.captureBackupFromContent(path, current);
    const next = current.slice(0, first) + newStr + current.slice(first + oldStr.length);
    const res = await this.writeFileViaTee(path, next);
    if (res.exitCode !== 0) {
      throw new Error(`str_replace: write failed: ${res.stderr.toString("utf8").trim()}`);
    }
    return { path, replaced: true };
  }

  private async teInsert(
    path: string,
    insertLine: number,
    newStr: string,
  ): Promise<Record<string, unknown>> {
    const cur = await this.execIn(["cat", path]);
    if (cur.exitCode !== 0) {
      throw new Error(`insert: cannot read ${path}: ${cur.stderr.toString("utf8").trim()}`);
    }
    const current = cur.stdout.toString("utf8");
    const lines = current.split("\n");
    const clamped = Math.max(0, Math.min(insertLine, lines.length));
    const before = lines.slice(0, clamped);
    const after = lines.slice(clamped);
    const inserted = [...before, newStr, ...after].join("\n");
    await this.captureBackupFromContent(path, current);
    const res = await this.writeFileViaTee(path, inserted);
    if (res.exitCode !== 0) {
      throw new Error(`insert: write failed: ${res.stderr.toString("utf8").trim()}`);
    }
    return { path, inserted: true, at: clamped };
  }

  private async teUndo(path: string): Promise<Record<string, unknown>> {
    const backup = this.undoBackups.get(path);
    if (backup === undefined) {
      throw new Error(`undo_edit: no backup for ${path}`);
    }
    const res = await this.writeFileViaTee(path, backup);
    if (res.exitCode !== 0) {
      throw new Error(`undo_edit: restore failed: ${res.stderr.toString("utf8").trim()}`);
    }
    this.undoBackups.delete(path);
    return { path, restored: true };
  }

  private async captureBackup(path: string): Promise<void> {
    const res = await this.execIn(["cat", path]);
    if (res.exitCode === 0) {
      this.undoBackups.set(path, res.stdout.toString("utf8"));
    }
  }

  private captureBackupFromContent(path: string, content: string): Promise<void> {
    this.undoBackups.set(path, content);
    return Promise.resolve();
  }

  private async writeFileViaTee(path: string, content: string): Promise<DockerExecResult> {
    // `tee` takes the path as argv and content from stdin — no shell
    // interpolation. We pipe via our execFile runner's `input` hook.
    return this.execFile(
      "docker",
      [...this.dockerGlobalArgs(), "exec", "-i", this.containerName, "tee", path],
      {
        timeoutMs: this.defaultTimeoutMs,
        input: content,
      },
    );
  }
}

/** Minimal POSIX-shell single-quote escape, used only for opts.cwd in bash(). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
