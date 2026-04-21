import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/db";
import { evaluate, makeGate } from "@/policy";
import { CandidateEnvelopeSchema, proposed } from "@/types/actions";
import { idempotencyKey } from "@/util/idempotency";
import { log } from "@/util/log";

/**
 * Replay a JSONL file of CandidateEnvelopes through the policy gate
 * without executing anything on X. Writes each verdict to action_log
 * with status='proposed' | 'rejected' so you can tune thresholds
 * against real data.
 *
 * Usage:
 *   pnpm shadow:replay data/fixtures/candidates.jsonl
 */

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: pnpm shadow:replay <path-to-jsonl>\n");
    process.exit(2);
  }
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    process.stderr.write(`file not found: ${abs}\n`);
    process.exit(2);
  }

  const raw = readFileSync(abs, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const gate = makeGate();
  const database = db();

  const insert = database.prepare(
    `INSERT INTO action_log (idempotency_key, decision_id, kind, payload_json, rationale,
       confidence, relevance, target_entity_id, mode, status, reasons_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  );

  let approved = 0;
  let rejected = 0;
  let invalid = 0;

  for (const line of lines) {
    const json = JSON.parse(line);
    const parsed = CandidateEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const c = proposed(parsed.data);
    const v = evaluate(gate, c);
    const idem = idempotencyKey(c.action, c.sourceEventIds);

    if (v.approved) {
      approved++;
      insert.run(
        idem,
        v.cacheableDecisionId,
        c.action.kind,
        JSON.stringify(c.action),
        c.rationale,
        c.confidence,
        c.relevanceScore,
        c.targetEntityId ?? null,
        "shadow",
        "approved",
        null,
      );
    } else {
      rejected++;
      insert.run(
        idem,
        `dec_shadow_${Date.now()}_${rejected}`,
        c.action.kind,
        JSON.stringify(c.action),
        c.rationale,
        c.confidence,
        c.relevanceScore,
        c.targetEntityId ?? null,
        "shadow",
        "rejected",
        JSON.stringify({ reasons: v.reasons, ruleIds: v.ruleIds }),
      );
    }
  }

  log.info(
    { total: lines.length, approved, rejected, invalid },
    "shadow.replay.done",
  );
  process.stdout.write(
    `replayed ${lines.length}: approved=${approved} rejected=${rejected} invalid=${invalid}\n`,
  );
  process.exit(0);
}

void main().catch((err) => {
  log.error({ err }, "shadow.replay.failed");
  process.exit(1);
});
