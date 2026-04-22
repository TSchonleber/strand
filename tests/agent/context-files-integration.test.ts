import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentContext, DefaultToolRegistry, createBudget, runPlan } from "@/agent";
import type { LlmCall, LlmProvider, LlmResult, LlmUsage } from "@/clients/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costInUsdTicks: 0,
};

function makeResult<T>(outputText: string, parsed: T | null): LlmResult<T> {
  return {
    outputText,
    parsed,
    responseId: "resp",
    systemFingerprint: null,
    usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 10 },
    toolCalls: [],
    rawResponse: {},
  };
}

function scriptedProvider(script: LlmResult<unknown>[]): LlmProvider & { calls: LlmCall[] } {
  let i = 0;
  const calls: LlmCall[] = [];
  return {
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
      if (!r) throw new Error(`scripted provider exhausted at call #${i - 1}`);
      return r as LlmResult<T>;
    },
    calls,
  };
}

function makeCtx(provider: LlmProvider, metadata: Record<string, unknown>): AgentContext {
  return {
    provider,
    tools: new DefaultToolRegistry(),
    budget: createBudget(),
    depth: 0,
    metadata,
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), "strand-ctxint-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("plan-runner × context-files", () => {
  it("injects repository context as a USER message when CLAUDE.md is present", async () => {
    const body = "# Strand rules\nbe opinionated, type-safe, no secrets in logs.";
    await fs.writeFile(join(tmp, "CLAUDE.md"), body, "utf8");

    const provider = scriptedProvider([
      makeResult("", { steps: [{ goal: "do work", allowedTools: [] }] }),
      makeResult("step complete", null),
      makeResult("", { achieved: true, reasoning: "ok" }),
    ]);
    const ctx = makeCtx(provider, { workdir: tmp });

    await runPlan({ ctx, goal: "root goal" });

    // Call #1 is the step agentic loop.
    const stepCall = provider.calls[1];
    expect(stepCall).toBeDefined();
    const messages = stepCall?.messages ?? [];
    // System + tools/root + context + sub-step.
    expect(messages).toHaveLength(4);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[2]?.role).toBe("user");
    expect(messages[3]?.role).toBe("user");

    const ctxMsg = messages[2]?.content as string;
    expect(ctxMsg).toContain("Repository context");
    expect(ctxMsg).toContain("be opinionated");
    expect(ctxMsg).toContain("CLAUDE.md");

    // Sub-step remains the last user message.
    expect(messages[3]?.content).toContain("Sub-step");
  });

  it("omits the context block entirely when no context files are present", async () => {
    const provider = scriptedProvider([
      makeResult("", { steps: [{ goal: "do work", allowedTools: [] }] }),
      makeResult("step complete", null),
      makeResult("", { achieved: true, reasoning: "ok" }),
    ]);
    const ctx = makeCtx(provider, { workdir: tmp });

    await runPlan({ ctx, goal: "root goal" });

    const stepCall = provider.calls[1];
    const messages = stepCall?.messages ?? [];
    // Exactly three: system, root+tools, sub-step. No context block.
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe("system");
    // No "Repository context" anywhere in the messages.
    expect(messages.some((m) => String(m.content).includes("Repository context"))).toBe(false);
    expect(messages[2]?.content).toContain("Sub-step");
  });
});
