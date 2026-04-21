import { db } from "@/db";

function main(): void {
  const events = db()
    .prepare(
      "SELECT id, kind, created_at FROM perceived_events ORDER BY created_at DESC LIMIT 20",
    )
    .all() as Array<{ id: string; kind: string; created_at: string }>;

  const actions = db()
    .prepare(
      "SELECT kind, status, rationale, created_at FROM action_log ORDER BY created_at DESC LIMIT 20",
    )
    .all() as Array<{ kind: string; status: string; rationale: string; created_at: string }>;

  process.stdout.write("recent events:\n");
  for (const e of events) {
    process.stdout.write(`  [${e.created_at}] ${e.kind} ${e.id}\n`);
  }
  process.stdout.write("\nrecent actions:\n");
  for (const a of actions) {
    process.stdout.write(`  [${a.created_at}] ${a.status.padEnd(9)} ${a.kind.padEnd(8)} ${a.rationale.slice(0, 80)}\n`);
  }
}

main();
