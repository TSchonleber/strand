import { log } from "@/util/log";
import { runPlan } from "./plan-runner";
import type { AgentContext, BudgetLimits, PlanRunResult } from "./types";

/**
 * Spawn a child agent with a narrowed tool set + forked budget.
 *
 * Use this when a parent agent decides a sub-task warrants its own
 * decomposition (e.g., "crawl site A" → spawn crawler-child; "summarize
 * doc B" → spawn writer-child). The child runs its own `runPlan` with:
 *
 *   - parent's LLM provider (one model family per run)
 *   - parent's executor (Docker sandbox, Noop, …)
 *   - allowlisted tools (subset of parent's registry)
 *   - forked budget (clamped to parent remaining + optional explicit caps)
 *   - depth+1 from parent
 *
 * Spend propagates: the child's LLM + tool usage debits the parent's
 * budget via the linked-budget contract in `budget.ts`.
 *
 * Max depth enforced at `runPlan` entry — returns `stopReason: "max_depth"`
 * when exceeded.
 */

export interface SpawnArgs {
  parent: AgentContext;
  goal: string;
  /** Subset of parent's registry names this child may call. */
  allowedTools: readonly string[];
  /** Optional explicit budget caps for the child (intersected with parent remaining). */
  budget?: Partial<BudgetLimits>;
  /** Child-specific metadata — merged onto parent's metadata. */
  metadata?: Record<string, unknown>;
  maxDepth?: number;
  maxSteps?: number;
  maxIterationsPerStep?: number;
}

export async function spawn(args: SpawnArgs): Promise<PlanRunResult> {
  const { parent, goal, allowedTools, budget, metadata, maxDepth, maxSteps, maxIterationsPerStep } =
    args;

  const childCtx: AgentContext = {
    provider: parent.provider,
    tools: parent.tools.allowlist(allowedTools),
    budget: parent.budget.fork(budget ?? {}),
    parent,
    depth: parent.depth + 1,
    metadata: { ...(parent.metadata ?? {}), ...(metadata ?? {}) },
    ...(parent.executor !== undefined ? { executor: parent.executor } : {}),
    ...(parent.signal !== undefined ? { signal: parent.signal } : {}),
  };

  log.info(
    {
      svc: "agent",
      op: "spawn",
      parentDepth: parent.depth,
      childDepth: childCtx.depth,
      toolCount: childCtx.tools.list().length,
      goal: goal.slice(0, 160),
    },
    "agent.spawn",
  );

  return runPlan({
    ctx: childCtx,
    goal,
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(maxIterationsPerStep !== undefined ? { maxIterationsPerStep } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  });
}
