import { closeDb, db } from "@/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReplay } from "../../scripts/replay-shadow";

/**
 * Seeds action_log with a handful of synthetic rows and walks them through
 * the current policy gate via runReplay(). Asserts the summary shape is
 * non-empty and matches the seed count.
 */

interface Seed {
  decisionId: string;
  action: unknown;
  rationale: string;
  confidence: number;
  relevance: number;
  targetEntityId: string | null;
  status: "approved" | "rejected" | "executed";
  reasonsJson: string | null;
}

function seed(database: ReturnType<typeof db>, rows: Seed[]): void {
  const insert = database.prepare(
    `INSERT INTO action_log (idempotency_key, decision_id, kind, payload_json, rationale,
       confidence, relevance, target_entity_id, mode, status, reasons_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shadow', ?, ?)`,
  );
  let i = 0;
  for (const r of rows) {
    i++;
    const actionObj = r.action as { kind: string };
    insert.run(
      `k_${i}_${r.decisionId}`,
      r.decisionId,
      actionObj.kind,
      JSON.stringify(r.action),
      r.rationale,
      r.confidence,
      r.relevance,
      r.targetEntityId,
      r.status,
      r.reasonsJson,
    );
  }
}

describe("replay-shadow", () => {
  beforeEach(() => {
    closeDb();
    db();
  });

  afterEach(() => {
    closeDb();
  });

  it("replays seeded action_log rows and returns a non-empty summary", () => {
    const database = db();
    seed(database, [
      {
        decisionId: "dec_01",
        action: { kind: "like", tweetId: "tw_a" },
        rationale: "vanilla like",
        confidence: 0.9,
        relevance: 0.9,
        targetEntityId: null,
        status: "executed",
        reasonsJson: null,
      },
      {
        decisionId: "dec_02",
        action: { kind: "bookmark", tweetId: "tw_b" },
        rationale: "vanilla bookmark",
        confidence: 0.95,
        relevance: 0.9,
        targetEntityId: null,
        status: "approved",
        reasonsJson: null,
      },
      {
        decisionId: "dec_03",
        action: {
          kind: "reply",
          tweetId: "tw_c",
          text: "ok",
        },
        rationale: "under-min-length reply - historically rejected",
        confidence: 0.4,
        relevance: 0.3,
        targetEntityId: null,
        status: "rejected",
        reasonsJson: JSON.stringify({ reasons: ["relevance_below_threshold"] }),
      },
      {
        decisionId: "dec_04",
        action: {
          kind: "dm",
          userId: "u_1",
          text: "hey, lining up what we saw at scale.",
        },
        rationale: "DM without target entity id",
        confidence: 0.9,
        relevance: 0.8,
        targetEntityId: null,
        status: "rejected",
        reasonsJson: JSON.stringify({ reasons: ["dm_no_mutual_context"] }),
      },
      {
        decisionId: "dec_05",
        action: { kind: "like", tweetId: "tw_d" },
        rationale: "another like",
        confidence: 0.85,
        relevance: 0.8,
        targetEntityId: null,
        status: "executed",
        reasonsJson: null,
      },
    ]);

    const summary = runReplay({ days: 30, limit: 100 });

    expect(summary.total).toBe(5);
    expect(summary.matching + summary.diverging + summary.skipped).toBe(5);
    expect(summary.runtimeMs).toBeGreaterThanOrEqual(0);
    // At least one row must have been processed (not skipped).
    expect(summary.matching + summary.diverging).toBeGreaterThan(0);
  });

  it("skips malformed payload_json without throwing", () => {
    const database = db();
    database
      .prepare(
        `INSERT INTO action_log (idempotency_key, decision_id, kind, payload_json, rationale,
         confidence, relevance, target_entity_id, mode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shadow', 'approved')`,
      )
      .run("bad_key", "dec_bad", "like", "not json", "x", 0.9, 0.9, null);

    const summary = runReplay({ days: 30, limit: 10 });
    expect(summary.total).toBe(1);
    expect(summary.skipped).toBe(1);
  });
});
