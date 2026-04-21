import { duplicatesRule, recordPostText } from "@/policy/duplicates";
import { describe, expect, it } from "vitest";
import { fx } from "../fixtures/candidate";
import { freshDb } from "../helpers/db";

describe("duplicatesRule", () => {
  it("passes for actions without text", () => {
    const db = freshDb();
    expect(duplicatesRule(db, fx.like()).ok).toBe(true);
    expect(duplicatesRule(db, fx.follow()).ok).toBe(true);
  });

  it("passes when no prior posts exist", () => {
    const db = freshDb();
    const r = duplicatesRule(db, fx.reply("first post about retrieval latency"));
    expect(r.ok).toBe(true);
  });

  it("passes when text is clearly different from prior posts", () => {
    const db = freshDb();
    recordPostText(
      db,
      "tw_a",
      "reasoning models are cheaper than you think if you stop sending junk context",
    );
    const r = duplicatesRule(
      db,
      fx.reply("pgvector holds up to 10M rows before the hnsw engines pull ahead"),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects when text is near-identical to a recent post", () => {
    const db = freshDb();
    const original = "reasoning models are cheaper than you think if you stop sending junk context";
    recordPostText(db, "tw_a", original);
    const r = duplicatesRule(db, fx.reply(original));
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("duplicates.7d");
  });

  it("rejects a slightly-edited near-duplicate", () => {
    const db = freshDb();
    recordPostText(
      db,
      "tw_a",
      "reasoning models are cheaper than you think if you stop sending junk context",
    );
    const r = duplicatesRule(
      db,
      fx.reply("reasoning models are cheaper than you think when you stop sending junk context!"),
    );
    expect(r.ok).toBe(false);
  });

  it("ignores posts older than 7 days", () => {
    const db = freshDb();
    const original = "reasoning models are cheaper than you think if you stop sending junk context";
    db.prepare("INSERT INTO post_embeddings (tweet_id, text, created_at) VALUES (?, ?, ?)").run(
      "tw_old",
      original,
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const r = duplicatesRule(db, fx.reply(original));
    expect(r.ok).toBe(true);
  });
});
