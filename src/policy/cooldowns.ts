import { policies } from "@/config";
import type { Candidate, CandidateState } from "@/types/actions";
import type Database from "better-sqlite3";

export interface CooldownResult {
  ok: boolean;
  reasons: string[];
  ruleIds: string[];
}

function targetOf<S extends CandidateState>(c: Candidate<S>): string | null {
  const a = c.action;
  if ("tweetId" in a) return `tweet:${a.tweetId}`;
  if ("userId" in a) return `user:${a.userId}`;
  return null;
}

export function checkCooldown(
  db: Database.Database,
  c: Candidate<"proposed">,
  now = Date.now(),
): CooldownResult {
  const reasons: string[] = [];
  const ruleIds: string[] = [];
  const target = targetOf(c);

  if (target) {
    const row = db
      .prepare("SELECT until_at FROM cooldowns WHERE scope = ? AND kind = ?")
      .get(`target:${target}`, "any") as { until_at: number } | undefined;
    if (row && row.until_at > now) {
      reasons.push(`cooldown_active:${target}:until=${new Date(row.until_at).toISOString()}`);
      ruleIds.push("cooldown.per_target");
    }
  }

  // DM: mutual-DM-per-target-days cooldown
  if (c.action.kind === "dm") {
    const scope = `dm:${c.action.userId}`;
    const row = db
      .prepare("SELECT until_at FROM cooldowns WHERE scope = ? AND kind = ?")
      .get(scope, "dm") as { until_at: number } | undefined;
    if (row && row.until_at > now) {
      reasons.push(`dm_cooldown:${c.action.userId}`);
      ruleIds.push("cooldown.dm");
    }
  }

  // Follow-after-unfollow churn guard
  if (c.action.kind === "follow") {
    const scope = `unfollow:${c.action.userId}`;
    const row = db
      .prepare("SELECT until_at FROM cooldowns WHERE scope = ? AND kind = ?")
      .get(scope, "follow_after_unfollow") as { until_at: number } | undefined;
    if (row && row.until_at > now) {
      reasons.push(`refollow_blocked:${c.action.userId}`);
      ruleIds.push("cooldown.refollow");
    }
  }

  return { ok: reasons.length === 0, reasons, ruleIds };
}

export function recordActionCooldowns(
  db: Database.Database,
  c: Candidate<"approved">,
  now = Date.now(),
): void {
  const target = targetOf(c);
  if (target) {
    const until = now + policies.cooldowns_minutes.per_target_any * 60_000;
    db.prepare(
      `INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, 'any', ?)
       ON CONFLICT(scope, kind) DO UPDATE SET until_at = MAX(cooldowns.until_at, excluded.until_at)`,
    ).run(`target:${target}`, until);
  }

  if (c.action.kind === "dm") {
    const until = now + policies.cooldowns_minutes.dm_per_target_days * 24 * 60 * 60_000;
    db.prepare(
      `INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, 'dm', ?)
       ON CONFLICT(scope, kind) DO UPDATE SET until_at = MAX(cooldowns.until_at, excluded.until_at)`,
    ).run(`dm:${c.action.userId}`, until);
  }

  if (c.action.kind === "unfollow") {
    const until = now + policies.cooldowns_minutes.follow_after_unfollow_days * 24 * 60 * 60_000;
    db.prepare(
      `INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, 'follow_after_unfollow', ?)
       ON CONFLICT(scope, kind) DO UPDATE SET until_at = MAX(cooldowns.until_at, excluded.until_at)`,
    ).run(`unfollow:${c.action.userId}`, until);
  }
}
