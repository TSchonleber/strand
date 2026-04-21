/**
 * Core agent-harness types.
 *
 * Strand's agent harness is organized around four primitives:
 *
 *   Tool          — a named, JSON-schema-described capability an agent can call
 *   ToolRegistry  — pluggable catalog of Tools; gated per-agent by allowlist
 *   Budget        — token / USD / wall-clock caps enforced across a run
 *   TaskGraph     — persistent tree of PlanSteps an agent is working through
 *
 * The runtime pieces (runAgenticLoop, runPlan, spawn) compose these; they
 * live in sibling files. This file has no dependencies on concrete adapters
 * or storage — just types.
 */

import type { LlmProvider, LlmUsage } from "@/clients/llm";
import type { ComputerExecutor } from "./executor";

// ─── Tool interface ─────────────────────────────────────────────────────────

export interface Tool<TArgs = unknown, TResult = unknown> {
  /** Stable name. Agents refer to tools by name. Must be unique per registry. */
  readonly name: string;
  /** Human- + model-readable description. Fed to the LLM as the tool's description. */
  readonly description: string;
  /** JSON Schema describing valid args. Used for provider tool-call validation. */
  readonly parameters: Record<string, unknown>;
  /**
   * Is this tool side-effecting / expensive / dangerous? Policy/gate code uses
   * this to decide whether a call needs per-invocation human review.
   */
  readonly sideEffects?: "none" | "local" | "external" | "destructive";
  /** If true, caller must mark the agent as `trusted` (STRAND_MODE=live). */
  readonly requiresLive?: boolean;
  /** Optional per-call gate. Throw to reject before `execute()` runs. */
  gate?(args: TArgs, ctx: AgentContext): Promise<void> | void;
  execute(args: TArgs, ctx: AgentContext): Promise<TResult>;
}

export interface ToolInvocation {
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  at: number;
}

// ─── ToolRegistry ───────────────────────────────────────────────────────────

export interface ToolRegistry {
  /** Register a tool. Throws if a tool with that name already exists. */
  register<A, R>(tool: Tool<A, R>): void;
  /** Remove a tool. No-op if it doesn't exist. */
  unregister(name: string): void;
  /** Return all registered tools. */
  list(): readonly Tool[];
  /** Look up a tool by name. */
  get(name: string): Tool | undefined;
  /**
   * Narrow the registry to an allowed subset — used when spawning child
   * agents with fewer tools than the parent.
   */
  allowlist(names: readonly string[]): ToolRegistry;
}

// ─── Budget ─────────────────────────────────────────────────────────────────

export interface BudgetLimits {
  /** Max USD ticks (1e-10 USD units). Falls back to Infinity if unset. */
  usdTicks?: number;
  /** Max LLM input + output tokens combined. */
  tokens?: number;
  /** Max wall-clock milliseconds from `start()`. */
  wallClockMs?: number;
  /** Max total tool invocations across the run. */
  toolCalls?: number;
}

export interface BudgetSnapshot {
  spentUsdTicks: number;
  spentTokens: number;
  elapsedMs: number;
  toolCalls: number;
  limits: BudgetLimits;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly reason: "usd" | "tokens" | "wallclock" | "toolcalls",
    public readonly snapshot: BudgetSnapshot,
  ) {
    super(`budget exceeded: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

export interface Budget {
  /** Called before an expensive op; throws BudgetExceededError if any cap breached. */
  check(): void;
  /** Record LLM usage incrementally after each chat(). */
  consumeUsage(usage: LlmUsage): void;
  /** Record a tool-call ping. */
  consumeToolCall(): void;
  /** Current usage snapshot for logging / UI. */
  snapshot(): BudgetSnapshot;
  /** Fork a child budget. Child's limits are min(parent, childLimits). */
  fork(childLimits?: Partial<BudgetLimits>): Budget;
}

// ─── TaskGraph ──────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "abandoned";

export interface PlanStep {
  id: string;
  parentId: string | null;
  goal: string;
  /** Tools the agent is allowed to call while working on this step. */
  allowedTools: readonly string[];
  /** Max agentic-loop iterations for this step. */
  maxIterations?: number;
  /** Optional per-step budget fork. */
  budget?: Partial<BudgetLimits>;
  status: StepStatus;
  /** Freeform output — usually the step's resolved text or a structured JSON. */
  result?: unknown;
  error?: string;
  /** Agent's own reflection on whether the step actually achieved the goal. */
  reflection?: string;
  createdAt: string; // ISO-8601
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskGraph {
  id: string;
  rootGoal: string;
  steps: PlanStep[];
  status: StepStatus;
  createdAt: string;
  updatedAt: string;
  /** Optional operator-attached metadata (tenant id, user id, source webhook, etc.) */
  metadata?: Record<string, unknown>;
}

export interface TaskGraphStore {
  /** Persist a new TaskGraph (idempotent on id). */
  save(graph: TaskGraph): Promise<void>;
  /** Load by id. Returns null if absent. */
  load(id: string): Promise<TaskGraph | null>;
  /** Update a step's status + result in-place. */
  updateStep(graphId: string, step: PlanStep): Promise<void>;
  /** List graphs by status. */
  listByStatus(status: StepStatus, limit?: number): Promise<TaskGraph[]>;
  /** Append a ToolInvocation to the graph's trace. */
  appendInvocation(graphId: string, stepId: string, inv: ToolInvocation): Promise<void>;
}

// ─── AgentContext ───────────────────────────────────────────────────────────

export interface AgentContext {
  /** LLM provider for this run. */
  provider: LlmProvider;
  /** Tool registry scoped to what this agent is allowed to call. */
  tools: ToolRegistry;
  /** Optional computer-use executor. */
  executor?: ComputerExecutor;
  /** Budget tracker for this run. */
  budget: Budget;
  /** Abort mid-run. */
  signal?: AbortSignal;
  /** Opaque per-run metadata (tenant id, tracer spans, correlation ids). */
  metadata?: Record<string, unknown>;
  /** Parent context for multi-agent runs (null at the top level). */
  parent?: AgentContext;
  /** Depth from the top-level context — 0 for root, 1+ for spawned children. */
  depth: number;
}

// ─── Plan runner return shape ───────────────────────────────────────────────

export interface PlanRunResult {
  graphId: string;
  rootGoal: string;
  status: StepStatus;
  finalOutput: string;
  steps: PlanStep[];
  totalUsage: LlmUsage;
  totalToolCalls: number;
  durationMs: number;
  /** What stopped the run — for observability. */
  stopReason: "completed" | "failed" | "budget_exceeded" | "abort" | "max_depth" | "error";
}
