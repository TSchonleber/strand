import { brain } from "@/clients/brain";
import * as x from "@/clients/x";
import { env } from "@/config";
import { db } from "@/db";
import { recordActionCooldowns } from "@/policy/cooldowns";
import { recordPostText } from "@/policy/duplicates";
import type { Candidate } from "@/types/actions";
import { idempotencyKey } from "@/util/idempotency";
import { loopLog } from "@/util/log";
import type { RateLimiter } from "@/util/ratelimit";

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

  if (env.STRAND_MODE === "shadow") {
    log.info({ key, kind: c.action.kind }, "actor.shadow");
    db()
      .prepare("UPDATE action_log SET status = 'executed' WHERE idempotency_key = ?")
      .run(key);
    return;
  }

  const t0 = Date.now();
  try {
    const result = await x.execute(c.action);

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

    db()
      .prepare(
        `UPDATE action_log
         SET status = 'failed', error_code = ?, error_message = ?, executed_at = datetime('now'), duration_ms = ?
         WHERE idempotency_key = ?`,
      )
      .run(code, msg, Date.now() - t0, key);

    try {
      await brain.outcome_annotate({ decision_id: decisionId, outcome: "failure", signals: { error: msg } });
    } catch (e2) {
      log.warn({ err: e2 }, "actor.outcome_annotate_failed");
    }

    log.error({ err, key, kind: c.action.kind }, "actor.failed");
    throw err;
  }
}
