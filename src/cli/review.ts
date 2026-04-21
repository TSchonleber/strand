import { createInterface } from "node:readline/promises";
import { db } from "@/db";

async function main(): Promise<void> {
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
    process.stdout.write("no pending reviews\n");
    rl.close();
    return;
  }

  for (const row of rows) {
    process.stdout.write(`\n--- ${row.decision_id} ---\n`);
    process.stdout.write(`${row.payload_json}\n`);
    if (row.reasons_json) process.stdout.write(`reasons: ${row.reasons_json}\n`);
    const answer = (await rl.question("approve/reject/skip [a/r/s]: ")).trim().toLowerCase();
    const decision = answer === "a" ? "approved" : answer === "r" ? "rejected" : null;
    if (!decision) continue;
    db()
      .prepare(
        "UPDATE human_review_queue SET decision = ?, decided_at = datetime('now') WHERE id = ?",
      )
      .run(decision, row.id);
    process.stdout.write(`→ ${decision}\n`);
  }
  rl.close();
}

void main();
