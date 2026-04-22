import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { CliContext } from "../index";
import { printLine } from "../util/output";

/**
 * Interactive review queue — walks open human_review_queue rows, prompts
 * approve/reject/skip for each, writes the verdict back.
 */
export function registerReviewCmd(program: Command, _ctx: CliContext): void {
  program
    .command("review")
    .description("interactively approve/reject open human_review_queue rows")
    .action(async () => {
      const { db } = await import("@/db");
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      const rows = db()
        .prepare(
          "SELECT id, decision_id, payload_json, reasons_json FROM human_review_queue WHERE decided_at IS NULL ORDER BY created_at ASC LIMIT 50",
        )
        .all() as Array<{
        id: number;
        decision_id: string;
        payload_json: string;
        reasons_json: string | null;
      }>;

      if (rows.length === 0) {
        printLine("no pending reviews");
        rl.close();
        return;
      }

      for (const row of rows) {
        printLine(`\n--- ${row.decision_id} ---`);
        printLine(row.payload_json);
        if (row.reasons_json) printLine(`reasons: ${row.reasons_json}`);
        const answer = (await rl.question("approve/reject/skip [a/r/s]: ")).trim().toLowerCase();
        const decision = answer === "a" ? "approved" : answer === "r" ? "rejected" : null;
        if (!decision) continue;
        db()
          .prepare(
            "UPDATE human_review_queue SET decision = ?, decided_at = datetime('now') WHERE id = ?",
          )
          .run(decision, row.id);
        printLine(`→ ${decision}`);
      }
      rl.close();
    });
}
