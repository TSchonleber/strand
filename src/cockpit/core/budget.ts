import { remaining } from "@/agent/budget";
import type { Budget, BudgetLimits } from "@/agent/types";

export const DEFAULT_COCKPIT_BUDGET_LIMITS: BudgetLimits = {
  tokens: 50_000,
  usdTicks: 2_000_000,
  wallClockMs: 300_000,
  toolCalls: 40,
};

export function defaultChildBudgetLimits(parent: Budget): BudgetLimits {
  const headroom = remaining(parent);
  const child: BudgetLimits = {};
  if (headroom.tokens !== undefined) child.tokens = Math.floor(headroom.tokens / 2);
  if (headroom.usdTicks !== undefined) child.usdTicks = Math.floor(headroom.usdTicks / 2);
  if (headroom.wallClockMs !== undefined) child.wallClockMs = Math.floor(headroom.wallClockMs / 2);
  if (headroom.toolCalls !== undefined) child.toolCalls = Math.floor(headroom.toolCalls / 2);
  return child;
}
