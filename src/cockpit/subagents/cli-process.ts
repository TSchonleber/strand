/**
 * cli-process subagent backend.
 *
 * Spawns CLI tools (claude, codex, etc.) as child processes, pipes their
 * output through a StreamParser, and normalizes everything into CockpitEvents.
 *
 * Oneshot mode: stdin closed after task, process runs to completion.
 * Interactive mode: TODO — tmux wrapping per hermes pattern.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { type DefaultBudget, createBudget } from "@/agent/budget";
import type { Budget, BudgetLimits } from "@/agent/types";
import { defaultChildBudgetLimits } from "../core/budget";
import type { CockpitEvent } from "../core/events";
import {
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  DEFAULT_SUBAGENT_HEARTBEAT_MS,
  DEFAULT_SUBAGENT_STALE_MS,
  MAX_SUBAGENT_DEPTH,
  type SpawnSpec,
  type Subagent,
  type SubagentHandle,
  type SubagentStatus,
} from "../core/subagents";
import { type StreamParser, createParser } from "./parsers";

export type AuthMode = "api_key" | "oauth_external" | "oauth_device_code";

export interface CliProcessBackendOptions {
  authMode?: AuthMode;
  maxConcurrentChildren?: number;
  parentBudget?: Budget;
}

export class CliProcessBackend implements Subagent {
  readonly id: string;
  readonly backend = "cli-process" as const;

  private readonly authMode: AuthMode;
  private readonly maxConcurrentChildren: number;
  private readonly parentBudget: Budget;
  private readonly activeChildren = new Map<string, CliProcessHandle>();

  constructor(options: CliProcessBackendOptions = {}) {
    this.id = `cli-process-${randomUUID().slice(0, 8)}`;
    this.authMode = options.authMode ?? "api_key";
    this.maxConcurrentChildren = options.maxConcurrentChildren ?? DEFAULT_MAX_CONCURRENT_CHILDREN;
    this.parentBudget = options.parentBudget ?? createBudget();
  }

  async spawn(spec: SpawnSpec): Promise<SubagentHandle> {
    const depth = spec.depth ?? 0;
    if (depth > MAX_SUBAGENT_DEPTH) {
      throw new Error(`Subagent depth ${depth} exceeds maximum ${MAX_SUBAGENT_DEPTH}`);
    }

    if (this.activeChildren.size >= this.maxConcurrentChildren) {
      throw new Error(`Concurrent children limit reached (${this.maxConcurrentChildren})`);
    }

    const mode = spec.mode ?? "oneshot";
    if (mode === "interactive") {
      // TODO: tmux wrapping for interactive mode per hermes pattern
      throw new Error("Interactive mode not yet implemented — use oneshot");
    }

    const cmd = spec.cmd;
    if (!cmd) {
      throw new Error("SpawnSpec.cmd is required for cli-process backend");
    }

    const args = resolveArgs(spec, this.authMode);
    const parser = createParser(spec.parser ?? "raw-text");

    const childLimits: BudgetLimits = spec.budget
      ? { ...defaultChildBudgetLimits(this.parentBudget), ...spec.budget }
      : defaultChildBudgetLimits(this.parentBudget);
    const childBudget = (this.parentBudget as DefaultBudget).fork(childLimits);

    const subagentId = `subagent-${randomUUID().slice(0, 8)}`;
    const handle = new CliProcessHandle(subagentId, cmd, args, spec.task, parser, childBudget);

    this.activeChildren.set(subagentId, handle);
    handle.onDone(() => this.activeChildren.delete(subagentId));
    handle.start();

    return handle;
  }

  activeCount(): number {
    return this.activeChildren.size;
  }
}

// ─── Handle ─────────────────────────────────────────────────────────────────

class CliProcessHandle implements SubagentHandle {
  private process: ChildProcess | null = null;
  private state: SubagentStatus["state"] = "queued";
  private exitCode: number | undefined;
  private readonly eventQueue: CockpitEvent[] = [];
  private resolveWaiter: (() => void) | null = null;
  private done = false;
  private doneCallbacks: Array<() => void> = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt: number = Date.now();
  private startedAt: string | undefined;
  private endedAt: string | undefined;

  constructor(
    private readonly subagentId: string,
    private readonly cmd: string,
    private readonly args: readonly string[],
    private readonly task: string,
    private readonly parser: StreamParser,
    readonly budget: Budget,
  ) {}

  onDone(cb: () => void): void {
    if (this.done) {
      cb();
    } else {
      this.doneCallbacks.push(cb);
    }
  }

  start(): void {
    this.state = "running";
    this.startedAt = new Date().toISOString();

    // Spawn event
    this.pushEvent({
      t: "subagent.spawn",
      subagentId: this.subagentId,
      backend: "cli-process",
      parentSessionId: "",
    });

    const proc = spawn(this.cmd, [...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.process = proc;

    // Swallow EPIPE on stdin — process may exit before we finish writing
    proc.stdin?.on("error", () => {});

    // Send task as stdin for oneshot mode, then close
    if (this.task) {
      proc.stdin?.write(this.task);
      proc.stdin?.end();
    }

    // Parse stdout
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        this.lastActivityAt = Date.now();
        const { events } = this.parser.parseLine(this.subagentId, line);
        for (const e of events) this.pushEvent(e);
      });
    }

    // Stderr as raw events
    if (proc.stderr) {
      const rl = createInterface({ input: proc.stderr });
      rl.on("line", (line) => {
        this.lastActivityAt = Date.now();
        this.pushEvent({
          t: "subagent.event",
          subagentId: this.subagentId,
          kind: "stderr",
          chunk: line,
        });
      });
    }

    proc.on("close", (code) => {
      this.exitCode = code ?? 1;
      const { events } = this.parser.finalize(this.subagentId, this.exitCode);
      for (const e of events) this.pushEvent(e);
      this.finish(code === 0 ? "completed" : "failed");
    });

    proc.on("error", (err) => {
      this.pushEvent({
        t: "subagent.event",
        subagentId: this.subagentId,
        kind: "stderr",
        chunk: err.message,
      });
      this.finish("failed");
    });

    // Heartbeat + stale detection
    this.heartbeatTimer = setInterval(() => {
      this.pushEvent({
        t: "subagent.event",
        subagentId: this.subagentId,
        kind: "status",
        chunk: "heartbeat",
      });
    }, DEFAULT_SUBAGENT_HEARTBEAT_MS);

    this.staleTimer = setTimeout(() => {
      if (Date.now() - this.lastActivityAt >= DEFAULT_SUBAGENT_STALE_MS) {
        this.cancel();
      }
    }, DEFAULT_SUBAGENT_STALE_MS);
  }

  async send(input: string): Promise<void> {
    if (!this.process?.stdin?.writable) {
      throw new Error("Cannot send input — process stdin is not writable");
    }
    this.process.stdin.write(input);
  }

  async status(): Promise<SubagentStatus> {
    const s: SubagentStatus = { state: this.state };
    if (this.startedAt !== undefined) s.startedAt = this.startedAt;
    if (this.endedAt !== undefined) s.endedAt = this.endedAt;
    if (this.exitCode !== undefined) s.exit = this.exitCode;
    return s;
  }

  async cancel(): Promise<void> {
    if (this.process && !this.done) {
      this.process.kill("SIGTERM");
      this.finish("cancelled");
    }
  }

  get events(): AsyncIterable<CockpitEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<CockpitEvent>> {
            while (true) {
              if (self.eventQueue.length > 0) {
                const event = self.eventQueue.shift();
                if (event !== undefined) return { value: event, done: false };
              }
              if (self.done) {
                return { value: undefined as unknown as CockpitEvent, done: true };
              }
              await new Promise<void>((resolve) => {
                self.resolveWaiter = resolve;
              });
            }
          },
        };
      },
    };
  }

  private pushEvent(event: CockpitEvent): void {
    this.eventQueue.push(event);
    if (this.resolveWaiter) {
      const resolve = this.resolveWaiter;
      this.resolveWaiter = null;
      resolve();
    }
  }

  private finish(state: SubagentStatus["state"]): void {
    if (this.done) return;
    this.done = true;
    this.state = state;
    this.endedAt = new Date().toISOString();

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);

    // Wake async iterator
    if (this.resolveWaiter) {
      const resolve = this.resolveWaiter;
      this.resolveWaiter = null;
      resolve();
    }

    for (const cb of this.doneCallbacks) cb();
    this.doneCallbacks = [];
  }
}

// ─── Arg resolution ─────────────────────────────────────────────────────────

/**
 * Resolve CLI args for a SpawnSpec, applying hard constraint #7:
 * - Never pass --bare when auth mode is oauth_external.
 * - In BYOK (api_key) Anthropic mode, --bare is default for subagent spawns.
 */
export function resolveArgs(spec: SpawnSpec, authMode: AuthMode): readonly string[] {
  const args = [...(spec.args ?? [])];

  const isClaude = spec.cmd === "claude";
  if (!isClaude) return args;

  const hasBare = args.includes("--bare");

  if (authMode === "oauth_external") {
    // Hard constraint #7: never pass --bare with oauth_external
    return args.filter((a) => a !== "--bare");
  }

  if (authMode === "api_key" && !hasBare) {
    // BYOK mode: --bare is default for subagent spawns
    return ["--bare", ...args];
  }

  return args;
}
