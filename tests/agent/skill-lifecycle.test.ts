import "../../tests/helpers/env";
import {
  type SkillDecision,
  SkillDecisionStore,
  SkillRecordStore,
  acceptProposal,
  rejectProposal,
  runNightlyScorer,
  toBrainctlDecisionEvent,
  tokenCostP50,
  tokenCostP95,
} from "@/agent/skills/lifecycle";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../helpers/db";

let d: BetterSqliteDatabase;
let store: SkillRecordStore;
let decisionStore: SkillDecisionStore;

beforeEach(() => {
  d = freshDb();
  store = new SkillRecordStore(d);
  decisionStore = new SkillDecisionStore(d);
});

afterEach(() => {
  d.close();
});

describe("SkillRecordStore", () => {
  it("upserts and retrieves a skill record", () => {
    store.upsert("test-skill", {
      status: "active",
      triggers: ["coding", "refactor"],
      supersedes: [],
    });
    const rec = store.get("test-skill");
    expect(rec).not.toBeNull();
    expect(rec?.name).toBe("test-skill");
    expect(rec?.status).toBe("active");
    expect(rec?.triggers).toEqual(["coding", "refactor"]);
    expect(rec?.usageCount).toBe(0);
    expect(rec?.trustScore).toBe(1.0);
  });

  it("records usage metrics and tracks success count", () => {
    store.upsert("test-skill", { status: "active" });
    store.recordUsage({ skillName: "test-skill", success: true, tokenCost: 500 });
    store.recordUsage({ skillName: "test-skill", success: true, tokenCost: 800 });
    store.recordUsage({ skillName: "test-skill", success: false, tokenCost: 200 });

    const rec = store.get("test-skill");
    expect(rec?.usageCount).toBe(3);
    expect(rec?.successCount).toBe(2);
    expect(rec?.tokenCostSamples).toEqual([500, 800, 200]);
    expect(rec?.lastUsedAt).toBeTruthy();
  });

  it("lists by status", () => {
    store.upsert("active-1", { status: "active" });
    store.upsert("active-2", { status: "active" });
    store.upsert("retired-1", { status: "retired" });
    expect(store.listByStatus("active")).toHaveLength(2);
    expect(store.listByStatus("retired")).toHaveLength(1);
  });

  it("creates record on first usage if it doesn't exist", () => {
    store.recordUsage({ skillName: "new-skill", success: true, tokenCost: 100 });
    const rec = store.get("new-skill");
    expect(rec).not.toBeNull();
    expect(rec?.usageCount).toBe(1);
  });
});

describe("tokenCost percentiles", () => {
  it("computes p50 and p95 from samples", () => {
    const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(tokenCostP50(samples)).toBe(500);
    expect(tokenCostP95(samples)).toBe(1000);
  });

  it("handles empty samples", () => {
    expect(tokenCostP50([])).toBe(0);
    expect(tokenCostP95([])).toBe(0);
  });

  it("handles single sample", () => {
    expect(tokenCostP50([42])).toBe(42);
    expect(tokenCostP95([42])).toBe(42);
  });
});

describe("nightly scorer", () => {
  it("queues retire for low-hit skill", () => {
    store.upsert("low-hit", { status: "active", triggers: ["test"] });
    store.recordUsage({ skillName: "low-hit", success: true, tokenCost: 100 });

    store.upsert("popular", { status: "active", triggers: ["coding"] });
    for (let i = 0; i < 50; i++) {
      store.recordUsage({ skillName: "popular", success: true, tokenCost: 100 });
    }

    const result = runNightlyScorer({
      store,
      decisionStore,
      totalInvocations: 100,
    });

    expect(result.queuedRetire).toContain("low-hit");
    expect(result.queuedRetire).not.toContain("popular");

    const rec = store.get("low-hit");
    expect(rec?.status).toBe("queued_retire");
  });

  it("queues retire for low success rate skill (n >= 10)", () => {
    store.upsert("bad-skill", { status: "active", triggers: ["test"] });
    for (let i = 0; i < 10; i++) {
      store.recordUsage({
        skillName: "bad-skill",
        success: i < 3,
        tokenCost: 100,
      });
    }

    const result = runNightlyScorer({
      store,
      decisionStore,
      totalInvocations: 10,
    });

    expect(result.queuedRetire).toContain("bad-skill");
  });

  it("queues retire for superseded skill", () => {
    store.upsert("old-skill", { status: "active", triggers: ["coding"] });
    store.upsert("new-skill", {
      status: "active",
      triggers: ["coding"],
      supersedes: ["old-skill"],
    });
    for (let i = 0; i < 20; i++) {
      store.recordUsage({ skillName: "old-skill", success: true, tokenCost: 100 });
      store.recordUsage({ skillName: "new-skill", success: true, tokenCost: 100 });
    }

    const result = runNightlyScorer({
      store,
      decisionStore,
      totalInvocations: 40,
    });

    expect(result.queuedRetire).toContain("old-skill");
    expect(result.queuedRetire).not.toContain("new-skill");
  });

  it("skips skills with suppressed retire proposals", () => {
    store.upsert("suppressed-skill", { status: "active", triggers: ["test"] });
    store.recordUsage({ skillName: "suppressed-skill", success: true, tokenCost: 100 });

    rejectProposal({
      store,
      decisionStore,
      skillName: "suppressed-skill",
      proposalKind: "retire",
      decidedBy: "user",
      rationale: "keep it",
    });
    // Manually reset back to active since rejectProposal doesn't change active→active
    store.updateStatus("suppressed-skill", "active");

    const result = runNightlyScorer({
      store,
      decisionStore,
      totalInvocations: 100,
    });

    expect(result.skipped).toContain("suppressed-skill");
    expect(result.queuedRetire).not.toContain("suppressed-skill");
  });
});

describe("accept / reject proposals", () => {
  it("accept retire removes skill from retrieval index", () => {
    store.upsert("to-retire", { status: "queued_retire", triggers: ["test"] });

    const decision = acceptProposal({
      store,
      decisionStore,
      skillName: "to-retire",
      proposalKind: "retire",
      decidedBy: "user",
      rationale: "low usage",
    });

    expect(decision.decision).toBe("accepted");

    const rec = store.get("to-retire");
    expect(rec?.status).toBe("retired");

    const active = store.listActive();
    expect(active.find((s) => s.name === "to-retire")).toBeUndefined();
  });

  it("accept draft promotes to active", () => {
    store.upsert("new-draft", { status: "queued_draft", triggers: ["review"] });

    acceptProposal({
      store,
      decisionStore,
      skillName: "new-draft",
      proposalKind: "draft",
      decidedBy: "user",
    });

    const rec = store.get("new-draft");
    expect(rec?.status).toBe("active");
  });

  it("reject suppresses same proposal for 30 days", () => {
    store.upsert("keep-me", { status: "queued_retire", triggers: ["test"] });

    rejectProposal({
      store,
      decisionStore,
      skillName: "keep-me",
      proposalKind: "retire",
      decidedBy: "user",
      rationale: "still useful",
    });

    expect(decisionStore.isSuppressed("keep-me", "retire")).toBe(true);
    expect(decisionStore.isSuppressed("keep-me", "draft")).toBe(false);

    const rec = store.get("keep-me");
    expect(rec?.status).toBe("active");
  });
});

describe("brainctl decision events", () => {
  it("converts a SkillDecision to a brainctl event shape", () => {
    const decision: SkillDecision = {
      id: "sd_123",
      skillName: "test-skill",
      proposalKind: "retire",
      decision: "accepted",
      decidedBy: "user",
      rationale: "low hit rate",
      suppressedUntil: null,
      createdAt: "2026-04-24T12:00:00.000Z",
    };

    const event = toBrainctlDecisionEvent(decision);
    expect(event.type).toBe("skill_decision");
    expect(event.skillName).toBe("test-skill");
    expect(event.proposalKind).toBe("retire");
    expect(event.decision).toBe("accepted");
    expect(event.decidedBy).toBe("user");
    expect(event.timestamp).toBe("2026-04-24T12:00:00.000Z");
  });
});
