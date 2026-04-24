import { disconnect as brainDisconnect } from "@/clients/brain";
import { fetchUser, pollUsage } from "@/clients/x";
import { env } from "@/config";
import { closeDb, db } from "@/db";
import { executeApproved } from "@/loops/actor";
import { consolidatorPoll, consolidatorRun } from "@/loops/consolidator";
import { dmTick, perceiverTick } from "@/loops/perceiver";
import { reasonerTick } from "@/loops/reasoner";
import { recordFollowerDelta, recordXHealth } from "@/metrics";
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

// Track which loops should drain vs halt completely when STRAND_HALT is set
type LoopMode = "run" | "drain" | "halt";

function every(
  ms: number,
  name: string,
  fn: () => Promise<void>,
  opts: { mode?: LoopMode } = {},
): LoopHandle {
  const run = async () => {
    if (stopping) return;

    // Phase 3 kill switch: drain semantics
    if (env.STRAND_HALT === "true") {
      const mode = opts.mode ?? "halt";
      if (mode === "halt") {
        log.warn({ loop: name }, "orchestrator.halt_skipping_loop");
        return;
      }
      if (mode === "drain") {
        log.info({ loop: name }, "orchestrator.drain_mode");
        // Continue to fn() - drain in-flight work
      }
      // mode === "run" continues normally (perceiver reads are safe)
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

  // Perceiver (reads): always run — reads are safe
  handles.push(every(120_000, "perceiver", perceiverTick, { mode: "run" }));

  // DM poll every 5 min (separate from mention/timeline poll)
  handles.push(every(300_000, "perceiver-dm", dmTick, { mode: "run" }));

  // Phase 2: Reasoner ticks every 10 min (shadow-mode). Emits ≤5 candidates.
  // Phase 3 kill switch: halt — stop emitting new candidates immediately
  handles.push(
    every(
      600_000,
      "reasoner",
      async () => {
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
      },
      { mode: "halt" },
    ),
  );

  // Consolidator: submit every 24 h, poll open batches every 30 min.
  handles.push(every(24 * 60 * 60 * 1000, "consolidator", consolidatorRun, { mode: "halt" }));
  handles.push(every(30 * 60 * 1000, "consolidator-poll", consolidatorPoll, { mode: "halt" }));

  // Sweeper: clean up expired TTL rows every hour — always run
  handles.push(
    every(
      60 * 60 * 1000,
      "sweeper",
      async () => {
        sweepExpired(db());
      },
      { mode: "run" },
    ),
  );

  // Phase 3: X health snapshot every 15 minutes — always run for monitoring
  handles.push(
    every(
      15 * 60 * 1000,
      "metrics-x-health",
      async () => {
        try {
          // Poll usage endpoint for accurate monthly cap tracking
          await pollUsage();
          // Record health for key endpoints (rate limits tracked in x client)
          recordXHealth("mentions", { healthy: true });
          recordXHealth("dm_events", { healthy: true });
        } catch (err) {
          log.warn({ err }, "orchestrator.metrics_x_health_failed");
        }
      },
      { mode: "run" },
    ),
  );

  // Phase 3: Follower delta tracking every 1 hour — always run for monitoring
  handles.push(
    every(
      60 * 60 * 1000,
      "metrics-followers",
      async () => {
        try {
          const user = await fetchUser();
          recordFollowerDelta({
            followersCount: user.followersCount,
            followingCount: user.followingCount,
            listedCount: user.listedCount,
          });
          log.info(
            { followers: user.followersCount, following: user.followingCount },
            "orchestrator.followers_recorded",
          );
        } catch (err) {
          log.warn({ err }, "orchestrator.metrics_followers_failed");
        }
      },
      { mode: "run" },
    ),
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
