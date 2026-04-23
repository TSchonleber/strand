import type { Command } from "commander";
import type { CliContext } from "../index";
import { printLine, truncate } from "../util/output";

export function registerStatusCmd(program: Command, _ctx: CliContext): void {
  program
    .command("status")
    .description("orchestrator status + recent events / actions / reasoner / consolidator rows")
    .option("--json", "emit status as JSON for programmatic checks")
    .action(async (opts: { json?: boolean }) => {
      const { db } = await import("@/db");
      const dbh = db();

      if (opts.json) {
        // JSON output for 48h sanity checks
        const eventCounts = dbh
          .prepare("SELECT kind, COUNT(*) as count FROM perceived_events GROUP BY kind")
          .all() as Array<{ kind: string; count: number }>;

        const actionCounts = dbh
          .prepare("SELECT status, COUNT(*) as count FROM action_log GROUP BY status")
          .all() as Array<{ status: string; count: number }>;

        const firstEvent = dbh
          .prepare("SELECT created_at FROM perceived_events ORDER BY created_at ASC LIMIT 1")
          .get() as { created_at: string } | undefined;
        const lastEvent = dbh
          .prepare("SELECT created_at FROM perceived_events ORDER BY created_at DESC LIMIT 1")
          .get() as { created_at: string } | undefined;

        const orphanEvents = dbh
          .prepare("SELECT COUNT(*) as c FROM perceived_events WHERE forwarded_to_brain = 0")
          .get() as { c: number };

        const openReview = dbh
          .prepare("SELECT COUNT(*) as c FROM human_review_queue WHERE decided_at IS NULL")
          .get() as { c: number };

        const output = {
          env: {
            strand_mode: process.env["STRAND_MODE"] ?? null,
            llm_provider: process.env["LLM_PROVIDER"] ?? null,
            tier: process.env["TIER"] ?? null,
            strand_halt: process.env["STRAND_HALT"] ?? "false",
          },
          event_counts: Object.fromEntries(eventCounts.map((e) => [e.kind, e.count])),
          action_counts: Object.fromEntries(actionCounts.map((a) => [a.status, a.count])),
          event_time_range: {
            first: firstEvent?.created_at ?? null,
            last: lastEvent?.created_at ?? null,
          },
          orphan_events: orphanEvents.c,
          human_review_open: openReview.c,
          timestamp: new Date().toISOString(),
        };
        printLine(JSON.stringify(output, null, 2));
        return;
      }

      printLine("=== orchestrator ===");
      printLine(`STRAND_MODE         ${process.env["STRAND_MODE"] ?? "(unset)"}`);
      printLine(`LLM_PROVIDER        ${process.env["LLM_PROVIDER"] ?? "(unset)"}`);
      printLine(`credential store    ${process.env["STRAND_CREDENTIAL_STORE"] ?? "env"}`);
      printLine(`STRAND_HALT         ${process.env["STRAND_HALT"] ?? "false"}`);
      printLine("");

      const events = dbh
        .prepare(
          "SELECT id, kind, created_at FROM perceived_events ORDER BY created_at DESC LIMIT 20",
        )
        .all() as Array<{ id: string; kind: string; created_at: string }>;
      printLine(`=== recent perceived_events (${events.length}) ===`);
      for (const e of events) {
        printLine(`  [${e.created_at}] ${e.kind.padEnd(12)} ${e.id}`);
      }
      printLine("");

      const actions = dbh
        .prepare(
          "SELECT kind, status, rationale, created_at FROM action_log ORDER BY created_at DESC LIMIT 20",
        )
        .all() as Array<{ kind: string; status: string; rationale: string; created_at: string }>;
      printLine(`=== recent action_log (${actions.length}) ===`);
      for (const a of actions) {
        printLine(
          `  [${a.created_at}] ${a.status.padEnd(9)} ${a.kind.padEnd(8)} ${truncate(a.rationale ?? "", 80)}`,
        );
      }
      printLine("");

      const openReview = dbh
        .prepare("SELECT COUNT(*) as c FROM human_review_queue WHERE decided_at IS NULL")
        .get() as { c: number };
      printLine("=== human_review_queue ===");
      printLine(`  open: ${openReview.c}`);
      printLine("");

      const reasoner = dbh
        .prepare(
          "SELECT tick_at, candidate_count, tool_call_count, cost_in_usd_ticks FROM reasoner_runs ORDER BY tick_at DESC LIMIT 5",
        )
        .all() as Array<{
        tick_at: string;
        candidate_count: number;
        tool_call_count: number;
        cost_in_usd_ticks: number | null;
      }>;
      printLine(`=== last ${reasoner.length} reasoner_runs ===`);
      for (const r of reasoner) {
        printLine(
          `  [${r.tick_at}] candidates=${r.candidate_count} tool_calls=${r.tool_call_count} cost_ticks=${r.cost_in_usd_ticks ?? 0}`,
        );
      }
      printLine("");

      const consolidator = dbh
        .prepare(
          "SELECT status, batch_id, completed_at, created_at FROM consolidator_runs ORDER BY created_at DESC LIMIT 5",
        )
        .all() as Array<{
        status: string;
        batch_id: string | null;
        completed_at: string | null;
        created_at: string;
      }>;
      printLine(`=== last ${consolidator.length} consolidator_runs ===`);
      for (const c of consolidator) {
        printLine(
          `  [${c.created_at}] ${c.status.padEnd(11)} batch=${c.batch_id ?? "—"}  completed=${c.completed_at ?? "—"}`,
        );
      }
    });
}
