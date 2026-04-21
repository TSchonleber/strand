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
 *   • DockerExecutor (stub): target backend. Real implementation runs the
 *     action inside a sandboxed container with screencap-over-VNC + input
 *     injection. Not fully implemented — throws on every method so callers
 *     fail loudly. A follow-up engagement ships the real sandbox.
 *
 * Never default to host-direct execution. The user must opt in explicitly
 * with a host backend + per-action human approval in Phase 0–6.
 */

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

export type TextEditorCommand =
  | "view"
  | "create"
  | "str_replace"
  | "insert"
  | "undo_edit";

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
    log.info(
      { svc: "exec", exec: this.name, op: "type", textLength: text.length },
      "exec.noop",
    );
  }

  async wait(seconds: number): Promise<void> {
    log.info({ svc: "exec", exec: this.name, op: "wait", seconds }, "exec.noop");
  }

  async bash(
    command: string,
    _opts?: { timeoutMs?: number; cwd?: string },
  ): Promise<BashResult> {
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

/**
 * Docker-sandboxed executor — STUB.
 *
 * Intended backend: a long-running container with a virtual display
 * (Xvfb/x11vnc), keyboard/mouse injection via xdotool, screen capture via
 * ffmpeg, shell via `docker exec`. Every action is rate-limited and logged.
 *
 * Not implemented in this pass — every method throws `Error("DockerExecutor
 * not implemented")`. Plugging in the real backend is a single-file change
 * once the sandbox image is built.
 */
export class DockerExecutor implements ComputerExecutor {
  readonly name = "docker";
  readonly safe = false; // flip to true once sandbox is verified

  constructor(
    public readonly config: {
      image?: string;
      containerName?: string;
      display?: string;
      socketPath?: string;
    } = {},
  ) {}

  private notImplemented(op: string): never {
    throw new Error(
      `DockerExecutor.${op}: not implemented. Plug in a sandbox before enabling computer-use in gated/live modes.`,
    );
  }

  async screenshot(): Promise<Screenshot> {
    return this.notImplemented("screenshot");
  }
  async cursorPosition(): Promise<{ x: number; y: number }> {
    return this.notImplemented("cursorPosition");
  }
  async mouseMove(_x: number, _y: number): Promise<void> {
    return this.notImplemented("mouseMove");
  }
  async click(_x: number, _y: number, _button?: MouseButton): Promise<void> {
    return this.notImplemented("click");
  }
  async doubleClick(_x: number, _y: number, _button?: MouseButton): Promise<void> {
    return this.notImplemented("doubleClick");
  }
  async mouseDown(_button?: MouseButton): Promise<void> {
    return this.notImplemented("mouseDown");
  }
  async mouseUp(_button?: MouseButton): Promise<void> {
    return this.notImplemented("mouseUp");
  }
  async scroll(_direction: ScrollDirection, _amount: number): Promise<void> {
    return this.notImplemented("scroll");
  }
  async key(_keys: string): Promise<void> {
    return this.notImplemented("key");
  }
  async type(_text: string): Promise<void> {
    return this.notImplemented("type");
  }
  async wait(seconds: number): Promise<void> {
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  async bash(
    _command: string,
    _opts?: { timeoutMs?: number; cwd?: string },
  ): Promise<BashResult> {
    return this.notImplemented("bash");
  }
  async textEditor(
    _command: TextEditorCommand,
    _args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.notImplemented("textEditor");
  }
}
