import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { CliContext } from "../index";
import { printLine, truncate } from "../util/output";

/**
 * Review commands.
 *
 * `strand review` (default) — walks open human_review_queue rows and
 * approves/rejects for each.
 *
 * Phase 2 subcommands:
 *   `strand review candidates` — walks unlabeled action_log rows and lets the
 *                                operator label each as good/bad/unclear.
 *   `strand review agreement`  — computes agreement % between policy verdict
 *                                and operator labels (Phase 2 → Phase 3 gate).
 */
export function registerReviewCmd(program: Command, _ctx: CliContext): void {
  const review = program
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

  // ─── Phase 2: `review candidates` ─────────────────────────────
  review
    .command("candidates")
    .description("label recent action_log candidates as good/bad/unclear (Phase 2 shadow eval)")
    .option("--limit <n>", "max rows to walk", "50")
    .option("--mode <mode>", "filter by mode (shadow|gated|live)", "shadow")
    .action(async (opts: { limit: string; mode: string }) => {
      const { db } = await import("@/db");
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 50);
      const rows = db()
        .prepare(
          `SELECT id, decision_id, kind, status, payload_json, rationale, confidence, relevance, reasons_json, created_at
           FROM action_log
           WHERE operator_label IS NULL AND mode = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(opts.mode, limit) as Array<{
        id: number;
        decision_id: string;
        kind: string;
        status: string;
        payload_json: string;
        rationale: string | null;
        confidence: number | null;
        relevance: number | null;
        reasons_json: string | null;
        created_at: string;
      }>;

      if (rows.length === 0) {
        printLine(`no unlabeled candidates in mode=${opts.mode}`);
        rl.close();
        return;
      }

      printLine(`${rows.length} unlabeled candidate(s) in mode=${opts.mode}\n`);

      let labeled = 0;
      for (const row of rows) {
        printLine(`\n─── [${row.created_at}] ${row.decision_id} ───`);
        printLine(`status:     ${row.status}`);
        printLine(`kind:       ${row.kind}`);
        printLine(`confidence: ${row.confidence ?? "—"}`);
        printLine(`relevance:  ${row.relevance ?? "—"}`);
        printLine(`payload:    ${truncate(row.payload_json, 200)}`);
        if (row.rationale) printLine(`rationale:  ${truncate(row.rationale, 300)}`);
        if (row.reasons_json) printLine(`reasons:    ${truncate(row.reasons_json, 200)}`);

        const answer = (await rl.question("label [g=good / b=bad / u=unclear / s=skip / q=quit]: "))
          .trim()
          .toLowerCase();

        if (answer === "q") break;
        const label =
          answer === "g" || answer === "good"
            ? "good"
            : answer === "b" || answer === "bad"
              ? "bad"
              : answer === "u" || answer === "unclear"
                ? "unclear"
                : null;
        if (!label) continue;

        const note = (await rl.question("note (optional, enter to skip): ")).trim();

        db()
          .prepare(
            `UPDATE action_log
             SET operator_label = ?, labeled_at = datetime('now'), label_note = ?
             WHERE id = ?`,
          )
          .run(label, note || null, row.id);
        labeled++;
        printLine(`→ ${label}`);
      }

      rl.close();
      printLine(`\n${labeled} labeled this session.`);
    });

  // ─── Phase 2: `review agreement` ──────────────────────────────
  review
    .command("agreement")
    .description("compute policy↔operator agreement (Phase 2 → Phase 3 gate: ≥80% over ≥100)")
    .option("--json", "emit JSON instead of human-readable output")
    .option("--mode <mode>", "filter by mode", "shadow")
    .action(async (opts: { json?: boolean; mode: string }) => {
      const { db } = await import("@/db");

      const rows = db()
        .prepare(
          `SELECT status, operator_label, confidence, relevance
           FROM action_log
           WHERE operator_label IS NOT NULL AND mode = ?`,
        )
        .all(opts.mode) as Array<{
        status: string;
        operator_label: string;
        confidence: number | null;
        relevance: number | null;
      }>;

      const total = rows.length;
      let agree = 0;
      let disagree = 0;
      let unclear = 0;
      let trueApprove = 0; // policy approved + label good
      let trueReject = 0; // policy rejected + label bad
      let falseApprove = 0; // policy approved + label bad
      let falseReject = 0; // policy rejected + label good

      for (const r of rows) {
        const policyApproved = r.status === "approved" || r.status === "executed";
        if (r.operator_label === "unclear") {
          unclear++;
          continue;
        }
        const operatorGood = r.operator_label === "good";
        if (policyApproved && operatorGood) {
          agree++;
          trueApprove++;
        } else if (!policyApproved && !operatorGood) {
          agree++;
          trueReject++;
        } else if (policyApproved && !operatorGood) {
          disagree++;
          falseApprove++;
        } else {
          disagree++;
          falseReject++;
        }
      }

      const decisive = agree + disagree;
      const agreementPct = decisive > 0 ? (agree / decisive) * 100 : 0;
      const gateMet = total >= 100 && agreementPct >= 80;

      if (opts.json) {
        printLine(
          JSON.stringify(
            {
              mode: opts.mode,
              total_labeled: total,
              decisive,
              unclear,
              agree,
              disagree,
              agreement_pct: Number(agreementPct.toFixed(2)),
              confusion_matrix: {
                true_approve: trueApprove,
                true_reject: trueReject,
                false_approve: falseApprove,
                false_reject: falseReject,
              },
              gate: {
                min_labeled: 100,
                min_agreement_pct: 80,
                met: gateMet,
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      printLine(`=== Phase 2 agreement (mode=${opts.mode}) ===`);
      printLine(`total labeled:    ${total}`);
      printLine(`  decisive:       ${decisive}  (good/bad)`);
      printLine(`  unclear:        ${unclear}`);
      printLine("");
      printLine(`agreement:        ${agreementPct.toFixed(2)}%  (${agree}/${decisive})`);
      printLine("");
      printLine("confusion matrix (rows=policy, cols=operator):");
      printLine("                  good    bad");
      printLine(
        `  approved     ${String(trueApprove).padStart(5)}  ${String(falseApprove).padStart(5)}`,
      );
      printLine(
        `  rejected     ${String(falseReject).padStart(5)}  ${String(trueReject).padStart(5)}`,
      );
      printLine("");
      printLine(
        `Phase 3 gate: ≥100 labeled AND ≥80% agreement  →  ${gateMet ? "✓ MET" : "✗ NOT MET"}`,
      );
      if (!gateMet) {
        const needLabels = Math.max(0, 100 - total);
        if (needLabels > 0) printLine(`  need ${needLabels} more labels`);
        if (agreementPct < 80 && decisive > 0) {
          printLine(`  need agreement ≥80% (currently ${agreementPct.toFixed(1)}%)`);
        }
      }
    });
}
