import { policies } from "@/config";
import { relevanceRule } from "@/policy/topicalRelevance";
import { describe, expect, it } from "vitest";
import { fx } from "../fixtures/candidate";

describe("relevanceRule", () => {
  it("no-ops for actions that don't need relevance (like, follow, post)", () => {
    expect(relevanceRule(fx.like()).ok).toBe(true);
    expect(relevanceRule(fx.follow()).ok).toBe(true);
    expect(relevanceRule(fx.post()).ok).toBe(true);
    expect(relevanceRule(fx.bookmark()).ok).toBe(true);
  });

  it("rejects reply with relevance below threshold", () => {
    const c = fx.reply("text", "tw_1", {
      relevanceScore: policies.thresholds.min_relevance_reply - 0.01,
    });
    const r = relevanceRule(c);
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("relevance.reply");
  });

  it("accepts reply at threshold", () => {
    const c = fx.reply("text", "tw_1", {
      relevanceScore: policies.thresholds.min_relevance_reply,
    });
    expect(relevanceRule(c).ok).toBe(true);
  });

  it("rejects quote with relevance below quote threshold", () => {
    const c = fx.quote("text", "tw_1", {
      relevanceScore: policies.thresholds.min_relevance_quote - 0.01,
    });
    expect(relevanceRule(c).ok).toBe(false);
  });

  it("rejects dm with relevance below dm threshold (which is strictest)", () => {
    const c = fx.dm("text", "u_1", {
      relevanceScore: policies.thresholds.min_relevance_dm - 0.01,
    });
    expect(relevanceRule(c).ok).toBe(false);
  });
});
