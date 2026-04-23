import { disconnect as brainDisconnect } from "@/clients/brain";
import { env } from "@/config";
import { closeDb, db } from "@/db";
import { executeApproved } from "@/loops/actor";
import { consolidatorPoll, consolidatorRun } from "@/loops/consolidator";
import { dmTick, perceiverTick } from "@/loops/perceiver";
import { reasonerTick } from "@/loops/reasoner";
import { evaluate, makeGate } from "@/policy";
import { proposed } from "@/types/actions";
import { log } from "@/util/log";
import { sweepExpired } from "@/util/sweeper";

interface LoopHandle {
  name: string;
  timer: NodeJS.Timeout;
}

const handles: LoopHandle[] = [];
let stopping = false;

function every(ms: number, name: string, fn: () => Promise<void>): LoopHandle {
  const run = async () => {
    if (stopping) return;
    // Kill switch: env flag halts loop in <5s
    if (env.STRAND_HALT === "true") {
      log.warn({ loop: name }, "orchestrator.halt_skipping_loop");
      return;
    }
    try {
      await fn();
    } catch (err) {
      log.error({ err, loop: name }, "loop.unhandled_error");
    }
  };
  const timer = setInterval(run, ms);
  queueMicrotask(run); // fire once immediately
  return { name, timer };
}

export function start(): void {
  db(); // open + migrate
  const gate = makeGate();

  handles.push(every(120_000, "perceiver", perceiverTick));

  // DM poll every 5 min (separate from mention/timeline poll)
  handles.push(every(300_000, "perceiver-dm", dmTick));

  // Phase 2: Reasoner ticks every 10 min (shadow-mode). Emits ≤5 candidates.
  handles.push(
    every(600_000, "reasoner", async () => {
      const candidates = await reasonerTick();
      for (const c of candidates) {
        const verdict = evaluate(gate, proposed(c));
        if (verdict.approved) {
          await executeApproved({ rl: gate.rl }, verdict.candidate, verdict.cacheableDecisionId);
        } else {
          db()
            .prepare(
              `INSERT INTO action_log (idempotency_key, decision_id, kind, payload_json, rationale, confidence, relevance, target_entity_id, mode, status, reasons_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?)`,
            )
            .run(
              `rej_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              verdict.candidate.modelResponseId ?? "",
              c.action.kind,
              JSON.stringify(c.action),
              c.rationale,
              c.confidence,
              c.relevanceScore,
              c.targetEntityId ?? null,
              process.env["STRAND_MODE"] ?? "shadow",
              JSON.stringify({ reasons: verdict.reasons, ruleIds: verdict.ruleIds }),
            );
        }
      }
    }),
  );

  // Consolidator: submit every 24 h, poll open batches every 30 min.
  handles.push(every(24 * 60 * 60 * 1000, "consolidator", consolidatorRun));
  handles.push(every(30 * 60 * 1000, "consolidator-poll", consolidatorPoll));

  // Sweeper: clean up expired TTL rows every hour
  handles.push(
    every(60 * 60 * 1000, "sweeper", async () => {
      sweepExpired(db());
    }),
  );

  log.info({ loops: handles.map((h) => h.name) }, "orchestrator.started");
}

export async function stop(): Promise<void> {
  stopping = true;
  for (const h of handles) clearInterval(h.timer);
  await brainDisconnect();
  closeDb();
  log.info({}, "orchestrator.stopped");
}

export function registerShutdown(): void {
  const handler = async (sig: string) => {
    log.info({ sig }, "shutdown.signal");
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void handler("SIGINT"));
  process.on("SIGTERM", () => void handler("SIGTERM"));
}
