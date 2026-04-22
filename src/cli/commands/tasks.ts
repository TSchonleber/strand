import type { Command } from "commander";
import type { CliContext } from "../index";
import { printJson, printLine, printTable, truncate } from "../util/output";

type Status = "pending" | "running" | "completed" | "failed" | "skipped" | "abandoned";

const ALL_STATUSES: readonly Status[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "abandoned",
];

interface ListOpts {
  status?: Status;
  limit?: string;
  json?: boolean;
}

interface ShowOpts {
  json?: boolean;
}

export function registerTasksCmd(program: Command, _ctx: CliContext): void {
  const tasks = program.command("tasks").description("inspect persisted agent task graphs");

  tasks
    .command("list")
    .description("list task graphs (optionally filtered by status)")
    .option("--status <s>", "filter by status (pending|running|completed|failed|skipped|abandoned)")
    .option("--limit <n>", "max rows", "50")
    .option("--json", "emit JSON")
    .action(async (opts: ListOpts) => {
      const { SqliteTaskGraphStore } = await import("@/agent");
      const store = new SqliteTaskGraphStore();
      const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 50;
      const statuses: Status[] = opts.status ? [opts.status] : [...ALL_STATUSES];
      const graphs = (await Promise.all(statuses.map((s) => store.listByStatus(s, limit)))).flat();
      graphs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const slice = graphs.slice(0, limit);

      if (opts.json) {
        printJson(
          slice.map((g) => ({
            id: g.id,
            rootGoal: g.rootGoal,
            status: g.status,
            steps: g.steps.length,
            updatedAt: g.updatedAt,
          })),
        );
        return;
      }

      if (slice.length === 0) {
        printLine("no tasks");
        return;
      }
      printTable(slice, [
        { header: "id", value: (g) => g.id, maxWidth: 36 },
        { header: "status", value: (g) => g.status, maxWidth: 10 },
        { header: "steps", value: (g) => String(g.steps.length), maxWidth: 6 },
        { header: "updated", value: (g) => g.updatedAt, maxWidth: 25 },
        { header: "goal", value: (g) => truncate(g.rootGoal, 60), maxWidth: 60 },
      ]);
    });

  tasks
    .command("show")
    .description("show a single task graph")
    .argument("<id>", "graph id")
    .option("--json", "emit JSON")
    .action(async (id: string, opts: ShowOpts) => {
      const { SqliteTaskGraphStore } = await import("@/agent");
      const store = new SqliteTaskGraphStore();
      const g = await store.load(id);
      if (!g) {
        process.stderr.write(`task graph not found: ${id}\n`);
        process.exit(1);
      }
      if (opts.json) {
        printJson(g);
        return;
      }
      printLine(`id        ${g.id}`);
      printLine(`status    ${g.status}`);
      printLine(`rootGoal  ${g.rootGoal}`);
      printLine(`created   ${g.createdAt}`);
      printLine(`updated   ${g.updatedAt}`);
      printLine("");
      printLine("steps:");
      for (const [i, s] of g.steps.entries()) {
        printLine(`  ${i + 1}. [${s.status}] ${s.goal}`);
        if (s.reflection) printLine(`     reflection: ${truncate(s.reflection, 160)}`);
        if (s.error) printLine(`     error: ${truncate(s.error, 160)}`);
        if (s.result !== undefined) {
          const r = typeof s.result === "string" ? s.result : JSON.stringify(s.result);
          printLine(`     result: ${truncate(r, 160)}`);
        }
      }
    });

  tasks
    .command("resume")
    .description(
      "resume a task graph (prints next pending step; Phase 2.1 stub — actual mid-graph resume is 2.2)",
    )
    .argument("<id>", "graph id")
    .action(async (id: string) => {
      const { SqliteTaskGraphStore, resumeTaskGraph } = await import("@/agent");
      const store = new SqliteTaskGraphStore();
      const { graph, nextStep } = await resumeTaskGraph(store, id);
      if (!nextStep) {
        printLine(`graph ${graph.id}: nothing to resume (status=${graph.status})`);
        process.exit(1);
      }
      printLine(`graph ${graph.id}`);
      printLine(`next step: [${nextStep.status}] ${nextStep.goal}`);
      printLine("(mid-graph re-entry lands in Phase 2.2; not executed here)");
      process.exit(0);
    });

  tasks
    .command("cancel")
    .description("mark a task graph + its running steps as abandoned")
    .argument("<id>", "graph id")
    .action(async (id: string) => {
      const { SqliteTaskGraphStore } = await import("@/agent");
      const store = new SqliteTaskGraphStore();
      const graph = await store.load(id);
      if (!graph) {
        process.stderr.write(`task graph not found: ${id}\n`);
        process.exit(1);
      }
      const now = new Date().toISOString();
      graph.status = "abandoned";
      graph.updatedAt = now;
      for (const step of graph.steps) {
        if (step.status === "running" || step.status === "pending") {
          step.status = "abandoned";
          step.updatedAt = now;
          step.completedAt = now;
          await store.updateStep(graph.id, step);
        }
      }
      await store.save(graph);
      printLine(`cancelled: ${graph.id}`);
    });
}
