import { describe, expect, it } from "vitest";
import { checkCooldown, recordActionCooldowns } from "@/policy/cooldowns";
import { __unsafeMarkApproved } from "@/types/actions";
import { fx } from "../fixtures/candidate";
import { freshDb } from "../helpers/db";

describe("checkCooldown", () => {
  it("passes when no cooldown recorded", () => {
    const db = freshDb();
    const r = checkCooldown(db, fx.reply());
    expect(r.ok).toBe(true);
  });

  it("rejects reply to the same tweet while cooldown is active", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare("INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, 'any', ?)").run(
      "target:tweet:tw_1",
      now + 60 * 60 * 1000,
    );
    const r = checkCooldown(db, fx.reply("text", "tw_1"), now);
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("cooldown.per_target");
  });

  it("allows reply after cooldown has expired", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare("INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, 'any', ?)").run(
      "target:tweet:tw_1",
      now - 1, // already expired
    );
    const r = checkCooldown(db, fx.reply("text", "tw_1"), now);
    expect(r.ok).toBe(true);
  });

  it("blocks DM to same user inside dm-per-target window", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare("INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, 'dm', ?)").run(
      "dm:u_42",
      now + 24 * 60 * 60 * 1000,
    );
    const r = checkCooldown(db, fx.dm("hello", "u_42"), now);
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("cooldown.dm");
  });

  it("blocks refollow after unfollow within window", () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      "INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, 'follow_after_unfollow', ?)",
    ).run("unfollow:u_1", now + 7 * 24 * 60 * 60 * 1000);
    const r = checkCooldown(db, fx.follow("u_1"), now);
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("cooldown.refollow");
  });
});

describe("recordActionCooldowns", () => {
  it("writes per-target cooldown after any action", () => {
    const db = freshDb();
    const c = __unsafeMarkApproved(fx.reply("hi", "tw_99"));
    recordActionCooldowns(db, c);
    const row = db
      .prepare("SELECT until_at FROM cooldowns WHERE scope = ? AND kind = 'any'")
      .get("target:tweet:tw_99") as { until_at: number } | undefined;
    expect(row?.until_at).toBeGreaterThan(Date.now());
  });

  it("writes DM cooldown after a DM", () => {
    const db = freshDb();
    const c = __unsafeMarkApproved(fx.dm("hey", "u_7"));
    recordActionCooldowns(db, c);
    const row = db
      .prepare("SELECT until_at FROM cooldowns WHERE scope = ? AND kind = 'dm'")
      .get("dm:u_7") as { until_at: number } | undefined;
    expect(row?.until_at).toBeGreaterThan(Date.now() + 7 * 24 * 60 * 60 * 1000);
  });

  it("writes refollow guard after an unfollow", () => {
    const db = freshDb();
    const c = __unsafeMarkApproved(fx.unfollow("u_x"));
    recordActionCooldowns(db, c);
    const row = db
      .prepare("SELECT until_at FROM cooldowns WHERE scope = ? AND kind = 'follow_after_unfollow'")
      .get("unfollow:u_x") as { until_at: number } | undefined;
    expect(row?.until_at).toBeGreaterThan(Date.now());
  });
});
