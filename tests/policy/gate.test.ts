import { persona, policies } from "@/config";
import { closeDb, db } from "@/db";
import { evaluate, makeGate } from "@/policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fx } from "../fixtures/candidate";

/**
 * End-to-end policy gate tests. Uses the actual db() singleton running
 * in-memory via DATABASE_PATH=":memory:" (see tests/helpers/env.ts).
 */

describe("policy gate", () => {
  beforeEach(() => {
    // fresh in-memory DB per test
    closeDb();
    db(); // force open
  });

  afterEach(() => {
    closeDb();
  });

  it("approves a vanilla like", () => {
    const v = evaluate(makeGate(), fx.like("tw_new"));
    expect(v.approved).toBe(true);
  });

  it("rejects a reply that contains a banned topic", () => {
    const bannedTopic = persona.banned_topics[0] ?? "politics";
    const v = evaluate(makeGate(), fx.reply(`i think ${bannedTopic} is interesting`));
    expect(v.approved).toBe(false);
    if (!v.approved) expect(v.ruleIds).toContain("banned_topic");
  });

  it("rejects a reply below the relevance threshold", () => {
    const v = evaluate(
      makeGate(),
      fx.reply("some generic text", "tw_x", {
        relevanceScore: policies.thresholds.min_relevance_reply - 0.1,
      }),
    );
    expect(v.approved).toBe(false);
    if (!v.approved) expect(v.ruleIds).toContain("relevance.reply");
  });

  it("routes DMs to human review when policy requires it", () => {
    // policies.human_review_required.dm is true in shadow config
    const v = evaluate(makeGate(), fx.dm());
    expect(v.approved).toBe(false);
    if (!v.approved) {
      // Either explicit review flag OR dm.mutual_required if no target entity
      expect(
        v.reasons.some((r) => r === "requires_human_review" || r === "dm_no_mutual_context"),
      ).toBe(true);
    }
  });

  it("rejects low-confidence candidates when policy requires review", () => {
    const v = evaluate(
      makeGate(),
      fx.reply("a reasonable reply", "tw_lc", {
        confidence: policies.thresholds.min_confidence_no_review - 0.1,
      }),
    );
    expect(v.approved).toBe(false);
  });

  it("the approved verdict carries a decisionId", () => {
    const v = evaluate(makeGate(), fx.bookmark("tw_book"));
    expect(v.approved).toBe(true);
    if (v.approved) expect(v.cacheableDecisionId.startsWith("dec_")).toBe(true);
  });
});
