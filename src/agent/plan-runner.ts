import { randomUUID } from "node:crypto";
import type { LlmMessage, LlmUsage } from "@/clients/llm";
import { log } from "@/util/log";
import { localToolsForAgent } from "./context";
import { runAgenticLoop } from "./loop";
import {
  DECOMPOSE_CACHE_KEY,
  DECOMPOSE_SYSTEM,
  REFLECT_CACHE_KEY,
  REFLECT_SYSTEM,
  STEP_CACHE_KEY,
  STEP_SYSTEM,
} from "./prompts";
import type {
  AgentContext,
  PlanRunResult,
  PlanStep,
  StepStatus,
  TaskGraph,
  TaskGraphStore,
  Tool,
} from "./types";
import { BudgetExceededError } from "./types";

/**
 * Plan runner — the cracked part.
 *
 * Flow:
 *   1. Decompose goal → 2–5 PlanSteps via LLM structured output.
 *   2. For each step:
 *      a. Fork budget (per-step cap, inherits parent remaining)
 *      b. Build scoped AgentContext (narrowed tool registry)
 *      c. runAgenticLoop with step's goal + allowed tools
 *      d. Reflection gate: did the step achieve its goal?
 *      e. Retry once with reflection feedback if not achieved
 *      f. Persist step state
 *   3. Synthesize final output across completed steps.
 *
 * Stops early on budget-exceeded / abort / provider-error. Returns
 * PlanRunResult with `stopReason` for observability.
 */

const DEFAULT_MAX_STEPS = 5;
const DEFAULT_MAX_ITERATIONS_PER_STEP = 4;
const DEFAULT_MAX_DEPTH = 3;

export interface RunPlanOpts {
  ctx: AgentContext;
  goal: string;
  maxSteps?: number;
  maxIterationsPerStep?: number;
  maxDepth?: number;
  /** Persist task-graph progress here (SQLite store, etc.). Optional. */
  store?: TaskGraphStore;
  onStepComplete?(step: PlanStep, graph: TaskGraph): void | Promise<void>;
  /** Graph metadata (tenant id, source webhook, etc.) */
  metadata?: Record<string, unknown>;
}

const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costInUsdTicks: 0,
};

function sumUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costInUsdTicks: a.costInUsdTicks + b.costInUsdTicks,
  };
}

const DECOMPOSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["goal", "allowedTools"],
        properties: {
          goal: { type: "string" },
          allowedTools: { type: "array", items: { type: "string" } },
          maxIterations: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
    },
  },
};

const REFLECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["achieved", "reasoning"],
  properties: {
    achieved: { type: "boolean" },
    reasoning: { type: "string" },
    retryAdvice: { type: "string" },
  },
};

interface DecomposedPlan {
  steps: Array<{ goal: string; allowedTools: string[]; maxIterations?: number }>;
}

interface Reflection {
  achieved: boolean;
  reasoning: string;
  retryAdvice?: string;
}

export async function runPlan(opts: RunPlanOpts): Promise<PlanRunResult> {
  const {
    ctx,
    goal,
    maxSteps = DEFAULT_MAX_STEPS,
    maxIterationsPerStep = DEFAULT_MAX_ITERATIONS_PER_STEP,
    maxDepth = DEFAULT_MAX_DEPTH,
    store,
    onStepComplete,
    metadata,
  } = opts;

  const t0 = Date.now();
  const graphId = randomUUID();
  let totalUsage: LlmUsage = { ...EMPTY_USAGE };
  let totalToolCalls = 0;

  if (ctx.depth > maxDepth) {
    return {
      graphId,
      rootGoal: goal,
      status: "abandoned",
      finalOutput: "",
      steps: [],
      totalUsage,
      totalToolCalls,
      durationMs: Date.now() - t0,
      stopReason: "max_depth",
    };
  }

  // ─── 1. Decompose ───────────────────────────────────────────────
  let plan: DecomposedPlan;
  try {
    plan = await decompose(ctx, goal, maxSteps);
  } catch (err) {
    log.error({ err, goal }, "plan.decompose_failed");
    return {
      graphId,
      rootGoal: goal,
      status: "failed",
      finalOutput: "",
      steps: [],
      totalUsage,
      totalToolCalls,
      durationMs: Date.now() - t0,
      stopReason: "error",
    };
  }

  // ─── 2. Build task graph + persist ─────────────────────────────
  const now = new Date().toISOString();
  const steps: PlanStep[] = plan.steps.slice(0, maxSteps).map((s, i) => {
    const step: PlanStep = {
      id: `${graphId}-${i}`,
      parentId: null,
      goal: s.goal,
      allowedTools: s.allowedTools,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    if (s.maxIterations !== undefined) step.maxIterations = s.maxIterations;
    return step;
  });

  const graph: TaskGraph = {
    id: graphId,
    rootGoal: goal,
    steps,
    status: "running",
    createdAt: now,
    updatedAt: now,
    ...(metadata !== undefined ? { metadata } : {}),
  };

  if (store) {
    try {
      await store.save(graph);
    } catch (err) {
      log.warn({ err, graphId }, "plan.store_save_failed");
    }
  }

  log.info(
    { svc: "agent", graphId, goal, stepCount: steps.length, depth: ctx.depth },
    "plan.decomposed",
  );

  // ─── 3. Execute each step ──────────────────────────────────────
  let stopReason: PlanRunResult["stopReason"] = "completed";
  for (const step of steps) {
    if (ctx.signal?.aborted) {
      stopReason = "abort";
      break;
    }

    try {
      ctx.budget.check();
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.warn({ graphId, stepId: step.id, reason: err.reason }, "plan.budget_exceeded");
        stopReason = "budget_exceeded";
        step.status = "skipped";
        step.updatedAt = new Date().toISOString();
        if (store) await safeUpdateStep(store, graphId, step);
        break;
      }
      throw err;
    }

    step.status = "running";
    step.startedAt = new Date().toISOString();
    step.updatedAt = step.startedAt;
    if (store) await safeUpdateStep(store, graphId, step);

    const stepCtx: AgentContext = {
      ...ctx,
      tools: ctx.tools.allowlist(step.allowedTools),
      budget: ctx.budget.fork(step.budget),
      parent: ctx,
      depth: ctx.depth,
      metadata: { ...(ctx.metadata ?? {}), graphId, stepId: step.id },
    };

    const stepIterations = step.maxIterations ?? maxIterationsPerStep;
    let output = "";
    let usage: LlmUsage = { ...EMPTY_USAGE };
    let toolCalls = 0;
    let error: string | undefined;
    let reflection: Reflection = {
      achieved: false,
      reasoning: "not evaluated",
    };
    try {
      const r = await executeStep({
        ctx: stepCtx,
        goal: step.goal,
        maxIterations: stepIterations,
        rootGoal: goal,
      });
      output = r.output;
      usage = r.usage;
      toolCalls = r.toolCalls;
      error = r.error;
      reflection = r.reflection;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.warn({ graphId, stepId: step.id, reason: err.reason }, "plan.step.budget_exceeded");
        stopReason = "budget_exceeded";
        step.status = "skipped";
        step.updatedAt = new Date().toISOString();
        step.completedAt = step.updatedAt;
        if (store) await safeUpdateStep(store, graphId, step);
        break;
      }
      throw err;
    }

    totalUsage = sumUsage(totalUsage, usage);
    totalToolCalls += toolCalls;

    step.result = output;
    step.reflection = reflection.reasoning;
    step.updatedAt = new Date().toISOString();
    step.completedAt = step.updatedAt;

    if (error) {
      step.status = "failed";
      step.error = error;
      stopReason = "failed";
    } else if (!reflection.achieved) {
      // Retry once with reflection feedback.
      log.info(
        { graphId, stepId: step.id, retryAdvice: reflection.retryAdvice },
        "plan.step.retry",
      );
      const retry = await executeStep({
        ctx: stepCtx,
        goal: step.goal,
        maxIterations: stepIterations,
        rootGoal: goal,
        ...(reflection.retryAdvice !== undefined ? { retryAdvice: reflection.retryAdvice } : {}),
      });
      totalUsage = sumUsage(totalUsage, retry.usage);
      totalToolCalls += retry.toolCalls;
      step.result = retry.output;
      if (retry.error) {
        step.status = "failed";
        step.error = retry.error;
        stopReason = "failed";
      } else if (!retry.reflection.achieved) {
        step.status = "failed";
        step.error = `step not achieved after retry: ${retry.reflection.reasoning}`;
        stopReason = "failed";
      } else {
        step.status = "completed";
      }
      step.reflection = `${step.reflection}\n— retry — \n${retry.reflection.reasoning}`;
    } else {
      step.status = "completed";
    }

    if (store) await safeUpdateStep(store, graphId, step);
    if (onStepComplete) await onStepComplete(step, graph);

    if (stopReason === "failed") break;
  }

  // ─── 4. Finalize graph ─────────────────────────────────────────
  const finalStatus: StepStatus = stopReason === "completed" ? "completed" : "failed";
  graph.status = finalStatus;
  graph.updatedAt = new Date().toISOString();

  const finalOutput = steps
    .filter((s) => s.status === "completed")
    .map((s, i) => `[step ${i + 1}] ${stringify(s.result)}`)
    .join("\n\n");

  log.info(
    {
      svc: "agent",
      graphId,
      status: finalStatus,
      stopReason,
      steps: steps.length,
      totalToolCalls,
      durationMs: Date.now() - t0,
      usage: totalUsage,
    },
    "plan.complete",
  );

  return {
    graphId,
    rootGoal: goal,
    status: finalStatus,
    finalOutput,
    steps,
    totalUsage,
    totalToolCalls,
    durationMs: Date.now() - t0,
    stopReason,
  };
}

/**
 * Render the tool catalog deterministically — sorted by name so registration
 * order can never bust the prompt cache. Cached per registry snapshot.
 */
function renderToolCatalog(tools: readonly Tool[]): string {
  if (tools.length === 0) return "(none registered)";
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `- ${t.name}: ${t.description} (side_effects=${t.sideEffects ?? "none"})`)
    .join("\n");
}

async function decompose(
  ctx: AgentContext,
  goal: string,
  maxSteps: number,
): Promise<DecomposedPlan> {
  // Prompt cache hygiene: the system prompt is a byte-stable constant.
  // Dynamic content (tool catalog, maxSteps, goal) lives in USER messages.
  // Catalog is sorted so insertion order can't bust the cache.
  const toolCatalog = renderToolCatalog(ctx.tools.list());

  const result = await ctx.provider.chat<DecomposedPlan>({
    model: modelFor(ctx),
    messages: [
      { role: "system", content: DECOMPOSE_SYSTEM },
      {
        role: "user",
        content: [
          `Available tools (${ctx.tools.list().length}):`,
          toolCatalog,
          "",
          `Target step count: 2–${maxSteps}. Prefer 3–5.`,
        ].join("\n"),
      },
      { role: "user", content: `Goal:\n${goal}` },
    ],
    promptCacheKey: DECOMPOSE_CACHE_KEY,
    structuredOutput: { name: "DecomposedPlan", schema: DECOMPOSE_SCHEMA, strict: true },
    maxOutputTokens: 1500,
  });
  ctx.budget.consumeUsage(result.usage);
  logCacheRatio("decompose", result.usage);

  const parsed = result.parsed ?? safeJson<DecomposedPlan>(result.outputText);
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error("plan decomposition returned no steps");
  }
  return parsed;
}

async function executeStep(args: {
  ctx: AgentContext;
  goal: string;
  rootGoal: string;
  maxIterations: number;
  retryAdvice?: string;
}): Promise<{
  output: string;
  usage: LlmUsage;
  toolCalls: number;
  error?: string;
  reflection: Reflection;
}> {
  const { ctx, goal, rootGoal, maxIterations, retryAdvice } = args;
  const localTools = localToolsForAgent(ctx);

  // Prompt cache hygiene: STEP_SYSTEM is byte-stable. All dynamic content
  // (root goal, sub-step goal, tool list, retry advice) lives in user
  // messages so the shared prefix hits cache across every step of every
  // run — parent and spawned children alike.
  const toolNames = [...ctx.tools.list()]
    .map((t) => t.name)
    .sort()
    .join(", ");

  const messages: LlmMessage[] = [
    { role: "system", content: STEP_SYSTEM },
    {
      role: "user",
      content: [`Root goal: ${rootGoal}`, `Available tools: ${toolNames || "none"}`].join("\n"),
    },
    { role: "user", content: `Sub-step:\n${goal}` },
  ];
  if (retryAdvice) {
    messages.push({
      role: "user",
      content: `Previous attempt feedback:\n${retryAdvice}`,
    });
  }

  try {
    const loop = await runAgenticLoop({
      provider: ctx.provider,
      model: modelFor(ctx),
      messages,
      localTools,
      maxIterations,
      promptCacheKey: STEP_CACHE_KEY,
      ...(ctx.executor !== undefined ? { executor: ctx.executor } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });

    ctx.budget.consumeUsage(loop.usage);
    logCacheRatio("step", loop.usage);
    const reflection = await reflect(ctx, goal, loop.finalText);
    return {
      output: loop.finalText,
      usage: loop.usage,
      toolCalls: loop.toolCallsTotal,
      reflection,
    };
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: "",
      usage: EMPTY_USAGE,
      toolCalls: 0,
      error: msg,
      reflection: {
        achieved: false,
        reasoning: `step execution threw: ${msg}`,
      },
    };
  }
}

async function reflect(ctx: AgentContext, goal: string, output: string): Promise<Reflection> {
  try {
    const result = await ctx.provider.chat<Reflection>({
      model: modelFor(ctx),
      messages: [
        { role: "system", content: REFLECT_SYSTEM },
        {
          role: "user",
          content: `Goal: ${goal}\n\nOutput:\n${output.slice(0, 2000)}`,
        },
      ],
      promptCacheKey: REFLECT_CACHE_KEY,
      structuredOutput: { name: "Reflection", schema: REFLECT_SCHEMA, strict: true },
      maxOutputTokens: 400,
    });
    ctx.budget.consumeUsage(result.usage);
    logCacheRatio("reflect", result.usage);
    const parsed = result.parsed ?? safeJson<Reflection>(result.outputText);
    if (!parsed) {
      return { achieved: false, reasoning: "reflection parse failed — assuming unachieved" };
    }
    return parsed;
  } catch (err) {
    log.warn({ err, goal }, "plan.reflect_failed");
    return {
      achieved: false,
      reasoning: `reflection threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Emit the per-call cache-hit ratio so operators can spot prefix drift
 * immediately. Anything below ~0.3 on the 2nd+ call is usually a bug
 * (dynamic junk leaked into the system prompt, or tool order churning).
 */
function logCacheRatio(site: "decompose" | "step" | "reflect", usage: LlmUsage): void {
  const input = usage.inputTokens || 1;
  const cached = usage.cachedInputTokens;
  const ratio = Math.round((cached / input) * 100) / 100;
  log.debug(
    {
      svc: "agent",
      op: "cache_ratio",
      site,
      inputTokens: usage.inputTokens,
      cachedInputTokens: cached,
      ratio,
    },
    "plan.cache_ratio",
  );
}

function modelFor(ctx: AgentContext): string {
  const meta = ctx.metadata ?? {};
  const m = meta["model"];
  if (typeof m === "string" && m.length > 0) return m;
  const envModel = process.env["LLM_MODEL_REASONER"];
  return envModel && envModel.length > 0 ? envModel : "grok-4.20-reasoning";
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

async function safeUpdateStep(
  store: TaskGraphStore,
  graphId: string,
  step: PlanStep,
): Promise<void> {
  try {
    await store.updateStep(graphId, step);
  } catch (err) {
    log.warn({ err, graphId, stepId: step.id }, "plan.store_update_failed");
  }
}
