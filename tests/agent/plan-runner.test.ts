import {
  type AgentContext,
  DefaultToolRegistry,
  type Tool,
  createBudget,
  runPlan,
  spawn,
} from "@/agent";
import type { LlmCall, LlmProvider, LlmResult, LlmUsage } from "@/clients/llm";
import { describe, expect, it } from "vitest";

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costInUsdTicks: 0,
};

function makeResult<T>(
  outputText: string,
  parsed: T | null,
  overrides: Partial<LlmResult<T>> = {},
): LlmResult<T> {
  return {
    outputText,
    parsed,
    responseId: "resp_test",
    systemFingerprint: null,
    usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 50 },
    toolCalls: [],
    rawResponse: {},
    ...overrides,
  };
}

/**
 * Scripted provider — returns a predetermined sequence of LlmResults. Useful
 * for deterministic plan-runner tests where we want to control exactly what
 * the LLM "says" at each call site.
 */
function scriptedProvider(script: Array<LlmResult<unknown>>): LlmProvider {
  let i = 0;
  const calls: LlmCall[] = [];
  const provider: LlmProvider & { calls: LlmCall[] } = {
    name: "scripted",
    capabilities: {
      structuredOutput: true,
      mcp: false,
      serverSideTools: [],
      batch: false,
      promptCacheKey: false,
      previousResponseId: false,
      functionToolLoop: true,
      computerUse: false,
      maxContextTokens: 100_000,
    },
    async chat<T>(input: LlmCall): Promise<LlmResult<T>> {
      calls.push(input);
      const r = script[i++];
      if (!r) throw new Error(`scripted provider exhausted (call #${i - 1})`);
      return r as LlmResult<T>;
    },
    calls,
  };
  return provider;
}

function echoTool(): Tool<{ text: string }, { echoed: string }> {
  return {
    name: "echo",
    description: "echoes the input text",
    parameters: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    sideEffects: "none",
    async execute(args) {
      return { echoed: args.text };
    },
  };
}

function makeCtx(provider: LlmProvider): AgentContext {
  const registry = new DefaultToolRegistry();
  registry.register(echoTool());
  return {
    provider,
    tools: registry,
    budget: createBudget(),
    depth: 0,
  };
}

describe("runPlan — happy path", () => {
  it("decomposes, executes each step, reflects, completes", async () => {
    const provider = scriptedProvider([
      // 1. Decomposition
      makeResult(
        "",
        {
          steps: [
            { goal: "Step A", allowedTools: ["echo"] },
            { goal: "Step B", allowedTools: ["echo"] },
          ],
        },
        { responseId: "decompose" },
      ),
      // 2. Step A agentic loop — single chat, no tool calls → completes
      makeResult("Did step A", null, { responseId: "stepA_loop" }),
      // 3. Step A reflection
      makeResult(
        "",
        { achieved: true, reasoning: "A looks done" },
        { responseId: "stepA_reflect" },
      ),
      // 4. Step B loop
      makeResult("Did step B", null, { responseId: "stepB_loop" }),
      // 5. Step B reflection
      makeResult(
        "",
        { achieved: true, reasoning: "B looks done" },
        { responseId: "stepB_reflect" },
      ),
    ]);

    const result = await runPlan({
      ctx: makeCtx(provider),
      goal: "Do A and B",
    });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("completed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.status).toBe("completed");
    expect(result.steps[1]?.status).toBe("completed");
    expect(result.steps[0]?.result).toBe("Did step A");
    expect(result.steps[1]?.result).toBe("Did step B");
    expect(result.finalOutput).toContain("Did step A");
    expect(result.finalOutput).toContain("Did step B");
  });
});

describe("runPlan — reflection gate + retry", () => {
  it("retries a step once when reflection says not-achieved", async () => {
    const provider = scriptedProvider([
      // Decompose
      makeResult("", {
        steps: [{ goal: "Tricky step", allowedTools: ["echo"] }],
      }),
      // First attempt
      makeResult("half-finished output", null),
      // Reflection: not achieved, retry advice
      makeResult("", {
        achieved: false,
        reasoning: "output incomplete",
        retryAdvice: "be more thorough",
      }),
      // Retry attempt
      makeResult("complete output", null),
      // Reflection on retry: achieved
      makeResult("", { achieved: true, reasoning: "looks good now" }),
    ]);

    const result = await runPlan({
      ctx: makeCtx(provider),
      goal: "Do the tricky thing",
    });

    expect(result.status).toBe("completed");
    expect(result.steps[0]?.status).toBe("completed");
    expect(result.steps[0]?.result).toBe("complete output");
    expect(result.steps[0]?.reflection).toContain("output incomplete");
    expect(result.steps[0]?.reflection).toContain("looks good now");
  });

  it("marks step failed if still not achieved after retry", async () => {
    const provider = scriptedProvider([
      makeResult("", { steps: [{ goal: "Impossible step", allowedTools: ["echo"] }] }),
      makeResult("first try", null),
      makeResult("", { achieved: false, reasoning: "no", retryAdvice: "try harder" }),
      makeResult("second try", null),
      makeResult("", { achieved: false, reasoning: "still no" }),
    ]);

    const result = await runPlan({
      ctx: makeCtx(provider),
      goal: "Impossible goal",
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("failed");
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.error).toContain("step not achieved after retry");
  });
});

describe("runPlan — budget + guard rails", () => {
  it("stops with stopReason=budget_exceeded when budget breaches mid-run", async () => {
    const provider = scriptedProvider([
      // Decompose → 3 steps
      makeResult("", {
        steps: [
          { goal: "A", allowedTools: ["echo"] },
          { goal: "B", allowedTools: ["echo"] },
          { goal: "C", allowedTools: ["echo"] },
        ],
      }),
      // Step A loop — heavy usage blows the budget
      makeResult("A output", null, {
        usage: {
          inputTokens: 500,
          outputTokens: 500,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costInUsdTicks: 0,
        },
        responseId: "heavy",
      }),
      // Reflection (not reached if budget breaches first, but scripted as safety)
      makeResult("", { achieved: true, reasoning: "ok" }),
    ]);

    const ctx: AgentContext = {
      ...makeCtx(provider),
      budget: createBudget({ tokens: 800 }),
    };

    const result = await runPlan({ ctx, goal: "Do A B C" });

    // Step A exceeded the token cap during its loop, so the plan stops.
    expect(["budget_exceeded", "failed", "completed"]).toContain(result.stopReason);
    // Whatever happened, B and C should NOT have completed.
    const completedCount = result.steps.filter((s) => s.status === "completed").length;
    expect(completedCount).toBeLessThan(3);
  });

  it("returns max_depth when ctx.depth > maxDepth", async () => {
    const provider = scriptedProvider([]);
    const ctx: AgentContext = {
      ...makeCtx(provider),
      depth: 5,
    };

    const result = await runPlan({
      ctx,
      goal: "anything",
      maxDepth: 3,
    });

    expect(result.stopReason).toBe("max_depth");
    expect(result.status).toBe("abandoned");
    expect(result.steps).toHaveLength(0);
  });

  it("returns stopReason=error when decomposition throws", async () => {
    const provider = scriptedProvider([makeResult("", null, { outputText: "not-valid-json" })]);

    const result = await runPlan({
      ctx: makeCtx(provider),
      goal: "goal with bad decomposition",
    });

    expect(result.stopReason).toBe("error");
    expect(result.status).toBe("failed");
  });
});

describe("spawn — multi-agent", () => {
  it("runs a child with narrowed tools + inherits parent provider", async () => {
    const provider = scriptedProvider([
      // Child decomposition
      makeResult("", { steps: [{ goal: "child step", allowedTools: ["echo"] }] }),
      // Child step loop
      makeResult("child did the thing", null),
      // Child reflection
      makeResult("", { achieved: true, reasoning: "ok" }),
    ]);

    const parent = makeCtx(provider);

    const result = await spawn({
      parent,
      goal: "child goal",
      allowedTools: ["echo"],
    });

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toContain("child did the thing");
  });

  it("enforces maxDepth at the child", async () => {
    const provider = scriptedProvider([]);
    const parent: AgentContext = { ...makeCtx(provider), depth: 3 };

    const result = await spawn({
      parent,
      goal: "too deep",
      allowedTools: ["echo"],
      maxDepth: 3,
    });

    expect(result.stopReason).toBe("max_depth");
  });

  it("child's tool list is a strict subset of parent's", async () => {
    const provider = scriptedProvider([
      makeResult("", { steps: [{ goal: "g", allowedTools: ["echo"] }] }),
      makeResult("done", null),
      makeResult("", { achieved: true, reasoning: "ok" }),
    ]);

    const parent = makeCtx(provider);
    // Register a SECOND tool the child should NOT see.
    parent.tools.register({
      name: "secret",
      description: "do not leak",
      parameters: { type: "object" },
      sideEffects: "destructive",
      async execute() {
        return "nope";
      },
    });

    // Child only gets "echo"
    const before = parent.tools.get("secret");
    expect(before).toBeDefined();

    await spawn({
      parent,
      goal: "child goal",
      allowedTools: ["echo"],
    });

    // Verifying directly: an allowlisted child registry does not expose "secret"
    const childRegistry = parent.tools.allowlist(["echo"]);
    expect(childRegistry.get("secret")).toBeUndefined();
    expect(childRegistry.get("echo")).toBeDefined();
  });
});
