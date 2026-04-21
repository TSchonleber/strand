import { createBudget, mergeLimits, remaining } from "@/agent/budget";
import { BudgetExceededError } from "@/agent/types";
import type { LlmUsage } from "@/clients/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function usage(partial: Partial<LlmUsage> = {}): LlmUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costInUsdTicks: 0,
    ...partial,
  };
}

describe("budget", () => {
  it("no limits: check() never throws and snapshot tracks spend", () => {
    const b = createBudget();
    b.consumeUsage(usage({ inputTokens: 1000, outputTokens: 500, costInUsdTicks: 999_999_999 }));
    b.consumeToolCall();
    b.consumeToolCall();
    b.check();
    const snap = b.snapshot();
    expect(snap.spentTokens).toBe(1500);
    expect(snap.spentUsdTicks).toBe(999_999_999);
    expect(snap.toolCalls).toBe(2);
  });

  it("token cap: consumeUsage over the cap throws reason=tokens", () => {
    const b = createBudget({ tokens: 100 });
    expect(() => b.consumeUsage(usage({ inputTokens: 60, outputTokens: 50 }))).toThrow(
      BudgetExceededError,
    );
    try {
      b.consumeUsage(usage({ inputTokens: 1 }));
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      expect((e as BudgetExceededError).reason).toBe("tokens");
      expect((e as BudgetExceededError).snapshot.limits.tokens).toBe(100);
    }
  });

  it("usd cap: reason=usd", () => {
    const b = createBudget({ usdTicks: 500 });
    let caught: BudgetExceededError | null = null;
    try {
      b.consumeUsage(usage({ costInUsdTicks: 600 }));
    } catch (e) {
      caught = e as BudgetExceededError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.reason).toBe("usd");
    expect(caught?.snapshot.spentUsdTicks).toBe(600);
  });

  it("wallclock cap via fake timers: reason=wallclock", () => {
    vi.useFakeTimers();
    try {
      const b = createBudget({ wallClockMs: 1000 });
      b.check(); // fresh: no throw
      vi.advanceTimersByTime(1500);
      let caught: BudgetExceededError | null = null;
      try {
        b.check();
      } catch (e) {
        caught = e as BudgetExceededError;
      }
      expect(caught?.reason).toBe("wallclock");
      expect(caught?.snapshot.elapsedMs).toBeGreaterThanOrEqual(1500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tool-call cap: consumeToolCall past cap throws reason=toolcalls", () => {
    const b = createBudget({ toolCalls: 2 });
    b.consumeToolCall();
    b.consumeToolCall();
    let caught: BudgetExceededError | null = null;
    try {
      b.consumeToolCall();
    } catch (e) {
      caught = e as BudgetExceededError;
    }
    expect(caught?.reason).toBe("toolcalls");
    expect(caught?.snapshot.toolCalls).toBe(3);
  });

  it("precedence: wallclock reported before usd when both breached", () => {
    vi.useFakeTimers();
    try {
      const b = createBudget({ wallClockMs: 100, usdTicks: 10 });
      vi.advanceTimersByTime(500);
      let caught: BudgetExceededError | null = null;
      try {
        b.consumeUsage(usage({ costInUsdTicks: 1_000_000 }));
      } catch (e) {
        caught = e as BudgetExceededError;
      }
      expect(caught?.reason).toBe("wallclock");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fork: child limit smaller than parent remaining → child breaches first", () => {
    const parent = createBudget({ tokens: 10_000 });
    const child = parent.fork({ tokens: 50 });
    let caught: BudgetExceededError | null = null;
    try {
      child.consumeUsage(usage({ inputTokens: 60 }));
    } catch (e) {
      caught = e as BudgetExceededError;
    }
    expect(caught?.reason).toBe("tokens");
    expect(caught?.snapshot.limits.tokens).toBe(50);
    // Parent did get the spend recorded.
    expect(parent.snapshot().spentTokens).toBe(60);
  });

  it("fork: child limits clamped to parent remaining", () => {
    const parent = createBudget({ tokens: 100 });
    parent.consumeUsage(usage({ inputTokens: 80 })); // 20 remaining
    // Asking for tokens=1000 — child should be clamped to 20.
    const child = parent.fork({ tokens: 1000 });
    expect(child.snapshot().limits.tokens).toBe(20);
    // Proves clamping: child breaches at 21, not 1001.
    let caught: BudgetExceededError | null = null;
    try {
      child.consumeUsage(usage({ inputTokens: 21 }));
    } catch (e) {
      caught = e as BudgetExceededError;
    }
    expect(caught?.reason).toBe("tokens");
  });

  it("fork: child spend propagates to parent snapshot", () => {
    const parent = createBudget();
    const c1 = parent.fork();
    const c2 = parent.fork();
    const c3 = parent.fork();
    for (const c of [c1, c2, c3]) {
      c.consumeToolCall();
      c.consumeToolCall();
      c.consumeToolCall();
      c.consumeToolCall();
      c.consumeToolCall();
    }
    expect(parent.snapshot().toolCalls).toBe(15);
    expect(c1.snapshot().toolCalls).toBe(5);
  });

  it("fork: ancestor breach trips the chain even if child is under its own cap", () => {
    const root = createBudget({ tokens: 100 });
    const child = root.fork({ tokens: 1000 }); // clamped to 100
    const grandchild = child.fork({ tokens: 1000 }); // clamped to 100
    let caught: BudgetExceededError | null = null;
    try {
      grandchild.consumeUsage(usage({ inputTokens: 150 }));
    } catch (e) {
      caught = e as BudgetExceededError;
    }
    expect(caught?.reason).toBe("tokens");
    // Parent AND grandparent saw the spend.
    expect(root.snapshot().spentTokens).toBe(150);
    expect(child.snapshot().spentTokens).toBe(150);
    expect(grandchild.snapshot().spentTokens).toBe(150);
  });

  it("fork nested 3 levels: leaf spend propagates through both intermediates", () => {
    const root = createBudget();
    const mid = root.fork();
    const leaf = mid.fork();
    leaf.consumeUsage(usage({ inputTokens: 7, outputTokens: 3, costInUsdTicks: 42 }));
    leaf.consumeToolCall();
    expect(root.snapshot().spentTokens).toBe(10);
    expect(mid.snapshot().spentTokens).toBe(10);
    expect(leaf.snapshot().spentTokens).toBe(10);
    expect(root.snapshot().spentUsdTicks).toBe(42);
    expect(root.snapshot().toolCalls).toBe(1);
  });

  it("remaining() subtracts spent from limits; undefined for unlimited axes", () => {
    const b = createBudget({ tokens: 100, usdTicks: 1000 });
    b.consumeUsage(usage({ inputTokens: 30, outputTokens: 10, costInUsdTicks: 250 }));
    b.consumeToolCall();
    const r = remaining(b);
    expect(r.tokens).toBe(60);
    expect(r.usdTicks).toBe(750);
    expect(r.wallClockMs).toBeUndefined();
    expect(r.toolCalls).toBeUndefined();
  });

  it("mergeLimits: intersection = min of defined, undefined defers", () => {
    expect(mergeLimits({ tokens: 100 }, { tokens: 50 })).toEqual({ tokens: 50 });
    expect(mergeLimits({ tokens: 100 }, {})).toEqual({ tokens: 100 });
    expect(mergeLimits({}, { usdTicks: 10 })).toEqual({ usdTicks: 10 });
    expect(
      mergeLimits(
        { tokens: 100, usdTicks: 500, wallClockMs: 1000, toolCalls: 5 },
        { tokens: 200, usdTicks: 100, wallClockMs: 2000, toolCalls: 3 },
      ),
    ).toEqual({ tokens: 100, usdTicks: 100, wallClockMs: 1000, toolCalls: 3 });
  });
});

describe("budget (fake-timer guard)", () => {
  beforeEach(() => {
    // no-op — individual tests opt in
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exactly-at-cap does NOT throw (strict > comparison)", () => {
    vi.useFakeTimers();
    const b = createBudget({ wallClockMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(() => b.check()).not.toThrow();
    vi.advanceTimersByTime(1);
    expect(() => b.check()).toThrow(BudgetExceededError);
  });
});
