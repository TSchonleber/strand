import { createBudget } from "@/agent/budget";
import { DEFAULT_COCKPIT_BUDGET_LIMITS, defaultChildBudgetLimits } from "@/cockpit/core/budget";
import {
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  DEFAULT_SUBAGENT_HEARTBEAT_MS,
  DEFAULT_SUBAGENT_STALE_MS,
  MAX_SUBAGENT_DEPTH,
} from "@/cockpit/core/subagents";
import { describe, expect, it } from "vitest";

describe("cockpit budget defaults", () => {
  it("has correct default limits from spec", () => {
    expect(DEFAULT_COCKPIT_BUDGET_LIMITS.tokens).toBe(50_000);
    expect(DEFAULT_COCKPIT_BUDGET_LIMITS.usdTicks).toBe(2_000_000);
    expect(DEFAULT_COCKPIT_BUDGET_LIMITS.wallClockMs).toBe(300_000);
    expect(DEFAULT_COCKPIT_BUDGET_LIMITS.toolCalls).toBe(40);
  });
});

describe("defaultChildBudgetLimits", () => {
  it("returns half of parent remaining on all dimensions", () => {
    const parent = createBudget({
      tokens: 10_000,
      usdTicks: 2_000_000,
      wallClockMs: 300_000,
      toolCalls: 40,
    });
    const child = defaultChildBudgetLimits(parent);
    expect(child.tokens).toBe(5_000);
    expect(child.usdTicks).toBe(1_000_000);
    expect(child.wallClockMs).toBe(150_000);
    expect(child.toolCalls).toBe(20);
  });

  it("halves remaining after partial consumption", () => {
    const parent = createBudget({
      tokens: 10_000,
      usdTicks: 2_000_000,
      wallClockMs: 300_000,
      toolCalls: 40,
    });
    // Simulate consuming some tokens/cost via LlmUsage
    parent.consumeUsage({
      inputTokens: 2_000,
      cachedInputTokens: 0,
      outputTokens: 2_000,
      reasoningTokens: 0,
      costInUsdTicks: 500_000,
    });
    for (let i = 0; i < 10; i++) parent.consumeToolCall();
    const child = defaultChildBudgetLimits(parent);
    expect(child.tokens).toBe(3_000); // (10000 - 4000) / 2
    expect(child.usdTicks).toBe(750_000); // (2000000 - 500000) / 2
    expect(child.toolCalls).toBe(15); // (40 - 10) / 2
  });
});

describe("subagent constants", () => {
  it("maxDepth is 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });

  it("maxConcurrentChildren defaults to 3", () => {
    expect(DEFAULT_MAX_CONCURRENT_CHILDREN).toBe(3);
  });

  it("heartbeat interval is 30s", () => {
    expect(DEFAULT_SUBAGENT_HEARTBEAT_MS).toBe(30_000);
  });

  it("stale timeout is 10 minutes", () => {
    expect(DEFAULT_SUBAGENT_STALE_MS).toBe(600_000);
  });
});
