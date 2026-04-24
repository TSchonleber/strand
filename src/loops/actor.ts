import { brain } from "@/clients/brain";
import * as x from "@/clients/x";
import { checkMonthlyCapHalt, incrementMonthlyUsage, isActorHalted } from "@/clients/x";
import { env } from "@/config";
import { db } from "@/db";
import { recordActionError } from "@/metrics";
import { recordActionCooldowns } from "@/policy/cooldowns";
import { recordPostText } from "@/policy/duplicates";
import type { Candidate } from "@/types/actions";
import { idempotencyKey, tweetDedupHash } from "@/util/idempotency";
import { loopLog } from "@/util/log";
import type { RateLimiter } from "@/util/ratelimit";
import { isDuplicateTweet, recordTweetHash } from "@/util/sweeper";

const log = loopLog("actor");

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface ActorDeps {
  rl: RateLimiter;
}

/**
 * Executes an approved candidate. The type signature enforces that:
 * only Candidate<"approved"> is accepted. Callers can't hand-roll this —
 * only src/policy/index.ts mints Approved.
 */
export async function executeApproved(
  deps: ActorDeps,
  c: Candidate<"approved">,
  decisionId: string,
): Promise<void> {
  // Circuit breaker: monthly cap halt
  if (isActorHalted() || checkMonthlyCapHalt()) {
    log.warn({}, "actor.halted_monthly_cap");
    throw new Error("Actor halted: monthly cap exceeded");
  }

  incrementMonthlyUsage();

  const key = idempotencyKey(c.action, c.sourceEventIds);

  const existing = db()
    .prepare("SELECT status FROM action_log WHERE idempotency_key = ?")
    .get(key) as { status: string } | undefined;

  if (existing && existing.status === "executed") {
    log.info({ key }, "actor.skip_duplicate");
    return;
  }

  db()
    .prepare(
      `INSERT OR IGNORE INTO action_log
       (idempotency_key, decision_id, kind, payload_json, rationale, confidence, relevance, target_entity_id, mode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
    )
    .run(
      key,
      decisionId,
      c.action.kind,
      JSON.stringify(c.action),
      c.rationale,
      c.confidence,
      c.relevanceScore,
      c.targetEntityId ?? null,
      env.STRAND_MODE,
    );

  // Phase 3: only like and bookmark are live; everything else stays shadow
  const isLowRisk = c.action.kind === "like" || c.action.kind === "bookmark";
  const isShadow = env.STRAND_MODE === "shadow" || (!isLowRisk && env.STRAND_MODE === "live");

  if (isShadow) {
    log.info(
      {
        key,
        kind: c.action.kind,
        reason: env.STRAND_MODE === "shadow" ? "mode_shadow" : "phase3_non_lowrisk",
      },
      "actor.shadow",
    );
    db().prepare("UPDATE action_log SET status = 'executed' WHERE idempotency_key = ?").run(key);
    return;
  }

  const t0 = Date.now();

  // Tweet dedup check for post/reply/quote before calling X
  if (c.action.kind === "post" || c.action.kind === "reply" || c.action.kind === "quote") {
    const hash = tweetDedupHash(c.action);
    if (isDuplicateTweet(db(), hash)) {
      log.warn({ key, hash }, "actor.reject_duplicate_tweet");
      db()
        .prepare(
          "UPDATE action_log SET status = 'rejected', error_code = 'DUPLICATE_TWEET' WHERE idempotency_key = ?",
        )
        .run(key);
      return;
    }
  }

  try {
    const result = await x.execute(c.action);

    // Record tweet hash for post/reply/quote to prevent future duplicates
    if (c.action.kind === "post" || c.action.kind === "reply" || c.action.kind === "quote") {
      const hash = tweetDedupHash(c.action);
      recordTweetHash(db(), hash, c.action.text);
    }

    db()
      .prepare(
        `UPDATE action_log
         SET status = 'executed', x_object_id = ?, executed_at = datetime('now'), duration_ms = ?
         WHERE idempotency_key = ?`,
      )
      .run(result.xObjectId, Date.now() - t0, key);

    // Rate counters only increment on successful execute.
    deps.rl.increment({ scope: "global", kind: c.action.kind, windowMs: DAY_MS });
    if (c.action.kind === "follow" || c.action.kind === "reply") {
      deps.rl.increment({ scope: "global", kind: c.action.kind, windowMs: HOUR_MS });
    }

    recordActionCooldowns(db(), c);

    if ("text" in c.action) {
      recordPostText(db(), result.xObjectId, c.action.text);
    }

    try {
      await brain.outcome_annotate({ decision_id: decisionId, outcome: "success" });
    } catch (err) {
      log.warn({ err }, "actor.outcome_annotate_failed");
    }

    log.info(
      { key, kind: c.action.kind, xObjectId: result.xObjectId, durationMs: Date.now() - t0 },
      "actor.executed",
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code ?? "UNKNOWN";

    // Record error rate for metrics
    recordActionError(c.action.kind, code);

    db()
      .prepare(
        `UPDATE action_log
         SET status = 'failed', error_code = ?, error_message = ?, executed_at = datetime('now'), duration_ms = ?
         WHERE idempotency_key = ?`,
      )
      .run(code, msg, Date.now() - t0, key);

    try {
      await brain.outcome_annotate({
        decision_id: decisionId,
        outcome: "failure",
        signals: { error: msg },
      });
    } catch (e2) {
      log.warn({ err: e2 }, "actor.outcome_annotate_failed");
    }

    log.error({ err, key, kind: c.action.kind }, "actor.failed");
    throw err;
  }
}
