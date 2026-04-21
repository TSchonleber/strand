import { db } from "@/db";
import { evaluate, makeGate } from "@/policy";
import {
  ActionSchema,
  CandidateEnvelopeSchema,
  type PolicyVerdict,
  proposed,
} from "@/types/actions";
import { log } from "@/util/log";

/**
 * Policy regression tool.
 *
 * Walks the last N days of action_log rows (which include the historical
 * verdict via `status` and the original payload) and replays each
 * candidate through the CURRENT policy gate. Reports matches vs
 * divergences so you can see how policy changes would have shifted
 * historical behavior.
 *
 * Usage:
 *   tsx scripts/replay-shadow.ts [--days=7] [--limit=500]
 *
 * Divergences are the OUTPUT, not an error — exit code 0 when replay
 * runs cleanly. Exit code 1 only for unrecoverable failures (DB missing,
 * malformed rows, etc.).
 */

interface Args {
  days: number;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { days: 7, limit: 500 };
  for (const raw of argv.slice(2)) {
    const m = /^--(days|limit)=(\d+)$/.exec(raw);
    if (!m) continue;
    const key = m[1] as "days" | "limit";
    const val = Number.parseInt(m[2] as string, 10);
    if (Number.isFinite(val) && val > 0) out[key] = val;
  }
  return out;
}

interface ReplayRow {
  decision_id: string;
  kind: string;
  payload_json: string;
  rationale: string | null;
  confidence: number | null;
  relevance: number | null;
  target_entity_id: string | null;
  status: string; // historical verdict — approved | rejected | executed | failed | proposed | reverted
  reasons_json: string | null;
  created_at: string;
}

interface Divergence {
  decisionId: string;
  kind: string;
  historicalVerdict: "approved" | "rejected";
  currentVerdict: "approved" | "rejected";
  changedReasons: {
    onlyInHistorical: string[];
    onlyInCurrent: string[];
  };
}

interface ReplaySummary {
  total: number;
  matching: number;
  diverging: number;
  skipped: number;
  divergences: Divergence[];
  runtimeMs: number;
}

function normalizeHistorical(status: string): "approved" | "rejected" | null {
  // action_log.status: proposed | approved | rejected | executed | failed | reverted
  if (
    status === "approved" ||
    status === "executed" ||
    status === "failed" ||
    status === "reverted"
  ) {
    return "approved";
  }
  if (status === "rejected") return "rejected";
  return null; // 'proposed' is ambiguous — skip
}

function verdictLabel(v: PolicyVerdict): "approved" | "rejected" {
  return v.approved ? "approved" : "rejected";
}

function verdictReasons(v: PolicyVerdict): string[] {
  if (v.approved) return [];
  return [...v.reasons];
}

function historicalReasons(reasonsJson: string | null): string[] {
  if (!reasonsJson) return [];
  try {
    const parsed = JSON.parse(reasonsJson) as { reasons?: unknown };
    if (Array.isArray(parsed.reasons)) {
      return parsed.reasons.filter((r): r is string => typeof r === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

function reasonDiff(
  historical: string[],
  current: string[],
): { onlyInHistorical: string[]; onlyInCurrent: string[] } {
  const h = new Set(historical);
  const c = new Set(current);
  return {
    onlyInHistorical: [...h].filter((x) => !c.has(x)),
    onlyInCurrent: [...c].filter((x) => !h.has(x)),
  };
}

export function runReplay(args: Args): ReplaySummary {
  const t0 = Date.now();
  const gate = makeGate();
  const database = db();

  const rows = database
    .prepare(
      `SELECT decision_id, kind, payload_json, rationale, confidence, relevance,
              target_entity_id, status, reasons_json, created_at
         FROM action_log
        WHERE created_at >= datetime('now', ?)
          AND status IN ('approved','rejected','executed','failed','reverted')
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(`-${args.days} days`, args.limit) as ReplayRow[];

  let matching = 0;
  let diverging = 0;
  let skipped = 0;
  const divergences: Divergence[] = [];

  for (const row of rows) {
    const historical = normalizeHistorical(row.status);
    if (!historical) {
      skipped++;
      continue;
    }

    let action: unknown;
    try {
      action = JSON.parse(row.payload_json);
    } catch {
      skipped++;
      continue;
    }

    const actionParsed = ActionSchema.safeParse(action);
    if (!actionParsed.success) {
      skipped++;
      continue;
    }

    const envelope = CandidateEnvelopeSchema.safeParse({
      action: actionParsed.data,
      rationale: row.rationale ?? "replay",
      confidence: row.confidence ?? 0.5,
      relevanceScore: row.relevance ?? 0.5,
      sourceEventIds: [],
      requiresHumanReview: false,
      ...(row.target_entity_id ? { targetEntityId: row.target_entity_id } : {}),
    });
    if (!envelope.success) {
      skipped++;
      continue;
    }

    const verdict = evaluate(gate, proposed(envelope.data));
    const current = verdictLabel(verdict);

    if (current === historical) {
      matching++;
      continue;
    }

    diverging++;
    divergences.push({
      decisionId: row.decision_id,
      kind: row.kind,
      historicalVerdict: historical,
      currentVerdict: current,
      changedReasons: reasonDiff(historicalReasons(row.reasons_json), verdictReasons(verdict)),
    });
  }

  return {
    total: rows.length,
    matching,
    diverging,
    skipped,
    divergences,
    runtimeMs: Date.now() - t0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  try {
    const summary = runReplay(args);
    log.info(
      {
        total: summary.total,
        matching: summary.matching,
        diverging: summary.diverging,
        skipped: summary.skipped,
        runtimeMs: summary.runtimeMs,
      },
      "shadow.replay.done",
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    log.error({ err }, "shadow.replay.failed");
    process.exit(1);
  }
}

// Only run main() when executed directly. The tests import `runReplay` from here.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
