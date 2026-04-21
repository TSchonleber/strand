/**
 * Budget tracker for agent runs.
 *
 * Caps four dimensions (USD ticks, tokens, wall-clock ms, tool calls) and
 * throws {@link BudgetExceededError} the moment any cap is breached. Budgets
 * compose via {@link DefaultBudget.fork}: child consumption flows up to the
 * parent, and any ancestor's cap trips the whole chain.
 *
 * Precedence when multiple caps are simultaneously breached (check only —
 * consume always increments first, then checks): wallclock → usd → tokens →
 * toolcalls. Cheapest-to-evaluate first; also the order an operator cares
 * about during an incident.
 */

import type { LlmUsage } from "@/clients/llm";
import { type Budget, BudgetExceededError, type BudgetLimits, type BudgetSnapshot } from "./types";

/** Intersect two {@link BudgetLimits} — min of defined values, undefined = unlimited. */
export function mergeLimits(a: BudgetLimits, b: BudgetLimits): BudgetLimits {
  const pick = (x: number | undefined, y: number | undefined): number | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    return Math.min(x, y);
  };
  const merged: BudgetLimits = {};
  const usd = pick(a.usdTicks, b.usdTicks);
  if (usd !== undefined) merged.usdTicks = usd;
  const tok = pick(a.tokens, b.tokens);
  if (tok !== undefined) merged.tokens = tok;
  const wc = pick(a.wallClockMs, b.wallClockMs);
  if (wc !== undefined) merged.wallClockMs = wc;
  const tc = pick(a.toolCalls, b.toolCalls);
  if (tc !== undefined) merged.toolCalls = tc;
  return merged;
}

/**
 * Headroom remaining against a budget's own limits. Undefined entries stay
 * undefined (unlimited axis); defined entries are clamped to >= 0.
 */
export function remaining(budget: Budget): BudgetLimits {
  const snap = budget.snapshot();
  const out: BudgetLimits = {};
  if (snap.limits.usdTicks !== undefined) {
    out.usdTicks = Math.max(0, snap.limits.usdTicks - snap.spentUsdTicks);
  }
  if (snap.limits.tokens !== undefined) {
    out.tokens = Math.max(0, snap.limits.tokens - snap.spentTokens);
  }
  if (snap.limits.wallClockMs !== undefined) {
    out.wallClockMs = Math.max(0, snap.limits.wallClockMs - snap.elapsedMs);
  }
  if (snap.limits.toolCalls !== undefined) {
    out.toolCalls = Math.max(0, snap.limits.toolCalls - snap.toolCalls);
  }
  return out;
}

export function createBudget(limits: BudgetLimits = {}): Budget {
  return new DefaultBudget(limits, null);
}

export class DefaultBudget implements Budget {
  private spentUsdTicks = 0;
  private spentTokens = 0;
  private toolCalls = 0;
  private readonly startedAt = Date.now();

  constructor(
    public readonly limits: BudgetLimits,
    private readonly parent: DefaultBudget | null,
  ) {}

  check(): void {
    // Walk self → root, throwing on the first breach. Each level evaluates
    // its own caps against its own accumulated spend.
    let node: DefaultBudget | null = this;
    while (node !== null) {
      node.checkSelf();
      node = node.parent;
    }
  }

  consumeUsage(usage: LlmUsage): void {
    // Increment up the chain first, then check the chain. Separating the two
    // phases means a throw from an ancestor still leaves the ledger
    // consistent (all levels account for the same spend).
    let node: DefaultBudget | null = this;
    while (node !== null) {
      node.addUsage(usage);
      node = node.parent;
    }
    this.check();
  }

  consumeToolCall(): void {
    let node: DefaultBudget | null = this;
    while (node !== null) {
      node.toolCalls += 1;
      node = node.parent;
    }
    this.check();
  }

  snapshot(): BudgetSnapshot {
    return {
      spentUsdTicks: this.spentUsdTicks,
      spentTokens: this.spentTokens,
      elapsedMs: Date.now() - this.startedAt,
      toolCalls: this.toolCalls,
      limits: this.limits,
    };
  }

  fork(childLimits?: Partial<BudgetLimits>): Budget {
    // Child caps = min(parentRemaining, childLimits). An unset childLimits
    // entry defers to the parent's remaining headroom; an unset parent axis
    // defers to the child's explicit cap; unset on both = unlimited.
    const parentRemaining = remaining(this);
    const explicit: BudgetLimits = childLimits ?? {};
    const clamped = mergeLimits(parentRemaining, explicit);
    return new DefaultBudget(clamped, this);
  }

  private addUsage(usage: LlmUsage): void {
    this.spentUsdTicks += usage.costInUsdTicks;
    this.spentTokens += usage.inputTokens + usage.outputTokens;
  }

  private checkSelf(): void {
    const snap = this.snapshot();
    // Precedence: wallclock → usd → tokens → toolcalls.
    if (snap.limits.wallClockMs !== undefined && snap.elapsedMs > snap.limits.wallClockMs) {
      throw new BudgetExceededError("wallclock", snap);
    }
    if (snap.limits.usdTicks !== undefined && snap.spentUsdTicks > snap.limits.usdTicks) {
      throw new BudgetExceededError("usd", snap);
    }
    if (snap.limits.tokens !== undefined && snap.spentTokens > snap.limits.tokens) {
      throw new BudgetExceededError("tokens", snap);
    }
    if (snap.limits.toolCalls !== undefined && snap.toolCalls > snap.limits.toolCalls) {
      throw new BudgetExceededError("toolcalls", snap);
    }
  }
}
