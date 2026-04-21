import { policies } from "@/config";
import type { Candidate } from "@/types/actions";

export interface RelevanceResult {
  ok: boolean;
  reasons: string[];
  ruleIds: string[];
}

export function relevanceRule(c: Candidate<"proposed">): RelevanceResult {
  const reasons: string[] = [];
  const ruleIds: string[] = [];

  const k = c.action.kind;
  const needs = k === "reply" || k === "quote" || k === "dm";
  if (!needs) return { ok: true, reasons, ruleIds };

  const minBy: Record<"reply" | "quote" | "dm", number> = {
    reply: policies.thresholds.min_relevance_reply,
    quote: policies.thresholds.min_relevance_quote,
    dm: policies.thresholds.min_relevance_dm,
  };
  const min = minBy[k];
  if (c.relevanceScore < min) {
    reasons.push(`low_relevance:${k}:${c.relevanceScore.toFixed(2)}<${min}`);
    ruleIds.push(`relevance.${k}`);
  }

  return { ok: reasons.length === 0, reasons, ruleIds };
}
