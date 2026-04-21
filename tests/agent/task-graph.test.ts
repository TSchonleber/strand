import { SqliteTaskGraphStore, createTaskGraph, resumeTaskGraph } from "@/agent/task-graph";
import type { PlanStep, TaskGraph, ToolInvocation } from "@/agent/types";
import { closeDb, db } from "@/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Persistent TaskGraph store unit tests. Runs against the real db() singleton
 * in :memory: mode (see tests/helpers/env.ts).
 */

function firstStep(graph: TaskGraph): PlanStep {
  const s = graph.steps[0];
  if (!s) throw new Error("graph has no steps");
  return s;
}

describe("SqliteTaskGraphStore", () => {
  beforeEach(() => {
    closeDb();
    db();
  });
  afterEach(() => {
    closeDb();
  });

  it("save → load round-trips all fields", async () => {
    const store = new SqliteTaskGraphStore();
    const graph = createTaskGraph({
      rootGoal: "ship it",
      steps: [
        {
          goal: "first",
          allowedTools: ["echo", "bash"],
          maxIterations: 5,
          budget: { tokens: 1000, usdTicks: 500 },
        },
        { goal: "second", allowedTools: [] },
      ],
      metadata: { tenant: "acme", correlation: "c-1" },
    });
    const s0 = firstStep(graph);
    s0.reflection = "preflight ok";
    s0.result = { k: "v", nested: { n: 1 } };
    s0.startedAt = "2025-01-01T00:00:00.000Z";

    await store.save(graph);
    const loaded = await store.load(graph.id);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error("loaded is null");
    expect(loaded.id).toBe(graph.id);
    expect(loaded.rootGoal).toBe("ship it");
    expect(loaded.metadata).toEqual({ tenant: "acme", correlation: "c-1" });
    expect(loaded.steps).toHaveLength(2);

    const first = loaded.steps[0];
    if (!first) throw new Error("missing first step");
    expect(first.goal).toBe("first");
    expect(first.allowedTools).toEqual(["echo", "bash"]);
    expect(first.maxIterations).toBe(5);
    expect(first.budget).toEqual({ tokens: 1000, usdTicks: 500 });
    expect(first.reflection).toBe("preflight ok");
    expect(first.result).toEqual({ k: "v", nested: { n: 1 } });
    expect(first.startedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("updateStep changes status + result + timestamps", async () => {
    const store = new SqliteTaskGraphStore();
    const graph = createTaskGraph({
      rootGoal: "g",
      steps: [{ goal: "s1", allowedTools: [] }],
    });
    await store.save(graph);

    const step = firstStep(graph);
    const updated: PlanStep = {
      ...step,
      status: "completed",
      result: { summary: "ok" },
      reflection: "done cleanly",
      startedAt: "2025-02-01T00:00:00.000Z",
      completedAt: "2025-02-01T00:00:05.000Z",
    };
    await store.updateStep(graph.id, updated);

    const loaded = await store.load(graph.id);
    if (!loaded) throw new Error("loaded null");
    const s = firstStep(loaded);
    expect(s.status).toBe("completed");
    expect(s.result).toEqual({ summary: "ok" });
    expect(s.reflection).toBe("done cleanly");
    expect(s.startedAt).toBe("2025-02-01T00:00:00.000Z");
    expect(s.completedAt).toBe("2025-02-01T00:00:05.000Z");
    expect(new Date(s.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(step.updatedAt).getTime(),
    );
  });

  it("appendInvocation inserts trace row", async () => {
    const store = new SqliteTaskGraphStore();
    const graph = createTaskGraph({
      rootGoal: "g",
      steps: [{ goal: "s1", allowedTools: ["echo"] }],
    });
    await store.save(graph);
    const inv: ToolInvocation = {
      name: "echo",
      args: { msg: "hi" },
      result: { echoed: "hi" },
      durationMs: 12,
      at: Date.parse("2025-03-01T00:00:00.000Z"),
    };
    await store.appendInvocation(graph.id, firstStep(graph).id, inv);

    const row = db()
      .prepare(
        "SELECT tool_name, args_json, result_json, duration_ms FROM agent_tool_invocations WHERE graph_id = ?",
      )
      .get(graph.id) as
      | { tool_name: string; args_json: string; result_json: string; duration_ms: number }
      | undefined;
    expect(row).toBeDefined();
    if (!row) throw new Error("row missing");
    expect(row.tool_name).toBe("echo");
    expect(JSON.parse(row.args_json)).toEqual({ msg: "hi" });
    expect(JSON.parse(row.result_json)).toEqual({ echoed: "hi" });
    expect(row.duration_ms).toBe(12);
  });

  it("listByStatus filters correctly", async () => {
    const store = new SqliteTaskGraphStore();
    const a = createTaskGraph({ rootGoal: "a", steps: [{ goal: "x", allowedTools: [] }] });
    const b = createTaskGraph({ rootGoal: "b", steps: [{ goal: "y", allowedTools: [] }] });
    const c = createTaskGraph({ rootGoal: "c", steps: [{ goal: "z", allowedTools: [] }] });
    b.status = "running";
    c.status = "completed";
    await store.save(a);
    await store.save(b);
    await store.save(c);

    const pending = await store.listByStatus("pending");
    expect(pending.map((g) => g.id)).toEqual([a.id]);

    const running = await store.listByStatus("running");
    expect(running.map((g) => g.id)).toEqual([b.id]);
    expect(running[0]?.steps).toHaveLength(1);

    const done = await store.listByStatus("completed");
    expect(done.map((g) => g.id)).toEqual([c.id]);

    const failed = await store.listByStatus("failed");
    expect(failed).toEqual([]);
  });

  it("resumeTaskGraph returns first pending step", async () => {
    const store = new SqliteTaskGraphStore();
    const graph = createTaskGraph({
      rootGoal: "g",
      steps: [
        { goal: "first", allowedTools: [] },
        { goal: "second", allowedTools: [] },
      ],
    });
    firstStep(graph).status = "completed";
    await store.save(graph);
    const { nextStep } = await resumeTaskGraph(store, graph.id);
    expect(nextStep?.goal).toBe("second");
    expect(nextStep?.status).toBe("pending");
  });

  it("resumeTaskGraph returns running step if the process died mid-run", async () => {
    const store = new SqliteTaskGraphStore();
    const graph = createTaskGraph({
      rootGoal: "g",
      steps: [
        { goal: "first", allowedTools: [] },
        { goal: "second", allowedTools: [] },
        { goal: "third", allowedTools: [] },
      ],
    });
    const [s0, s1] = graph.steps;
    if (!s0 || !s1) throw new Error("expected 3 steps");
    s0.status = "completed";
    s1.status = "running";
    await store.save(graph);
    const { nextStep } = await resumeTaskGraph(store, graph.id);
    expect(nextStep?.goal).toBe("second");
    expect(nextStep?.status).toBe("running");
  });

  it("resumeTaskGraph returns null when all steps completed", async () => {
    const store = new SqliteTaskGraphStore();
    const graph = createTaskGraph({
      rootGoal: "g",
      steps: [
        { goal: "first", allowedTools: [] },
        { goal: "second", allowedTools: [] },
      ],
    });
    for (const s of graph.steps) s.status = "completed";
    await store.save(graph);
    const { nextStep, graph: loaded } = await resumeTaskGraph(store, graph.id);
    expect(nextStep).toBeNull();
    expect(loaded.steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("createTaskGraph generates ids + timestamps", () => {
    const graph = createTaskGraph({
      rootGoal: "root",
      steps: [
        { goal: "a", allowedTools: [] },
        { goal: "b", allowedTools: ["echo"] },
      ],
    });
    expect(graph.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(graph.status).toBe("pending");
    expect(graph.createdAt).toBe(graph.updatedAt);
    expect(new Date(graph.createdAt).toString()).not.toBe("Invalid Date");
    const ids = new Set(graph.steps.map((s) => s.id));
    expect(ids.size).toBe(2);
    for (const s of graph.steps) {
      expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.status).toBe("pending");
      expect(s.parentId).toBeNull();
      expect(s.createdAt).toBe(s.updatedAt);
    }
  });

  it("ON DELETE CASCADE removes steps + invocations when graph deleted", async () => {
    const store = new SqliteTaskGraphStore();
    const graph = createTaskGraph({
      rootGoal: "g",
      steps: [{ goal: "x", allowedTools: ["echo"] }],
    });
    await store.save(graph);
    await store.appendInvocation(graph.id, firstStep(graph).id, {
      name: "echo",
      args: {},
      result: "ok",
      at: Date.now(),
    });

    const d = db();
    const stepCount = (): number =>
      (
        d
          .prepare("SELECT COUNT(*) AS c FROM agent_task_steps WHERE graph_id = ?")
          .get(graph.id) as { c: number }
      ).c;
    const invCount = (): number =>
      (
        d
          .prepare("SELECT COUNT(*) AS c FROM agent_tool_invocations WHERE graph_id = ?")
          .get(graph.id) as { c: number }
      ).c;
    expect(stepCount()).toBe(1);
    expect(invCount()).toBe(1);

    d.prepare("DELETE FROM agent_task_graphs WHERE id = ?").run(graph.id);

    expect(stepCount()).toBe(0);
    expect(invCount()).toBe(0);
  });

  it("metadata_json round-trips a nested object", async () => {
    const store = new SqliteTaskGraphStore();
    const metadata = {
      tenant: "t1",
      tracer: { spanId: "abc", sampled: true, tags: ["a", "b"] },
      counts: { reads: 3, writes: 0 },
    };
    const graph = createTaskGraph({
      rootGoal: "g",
      steps: [{ goal: "x", allowedTools: [] }],
      metadata,
    });
    await store.save(graph);
    const loaded = await store.load(graph.id);
    expect(loaded?.metadata).toEqual(metadata);
  });

  it("save is idempotent across re-saves (upsert path)", async () => {
    const store = new SqliteTaskGraphStore();
    const graph: TaskGraph = createTaskGraph({
      rootGoal: "g",
      steps: [{ goal: "s", allowedTools: [] }],
    });
    await store.save(graph);
    graph.status = "running";
    const s = firstStep(graph);
    s.status = "running";
    s.startedAt = "2025-04-01T00:00:00.000Z";
    await store.save(graph);
    const loaded = await store.load(graph.id);
    expect(loaded?.status).toBe("running");
    expect(loaded?.steps).toHaveLength(1);
    expect(loaded?.steps[0]?.status).toBe("running");
    expect(loaded?.steps[0]?.startedAt).toBe("2025-04-01T00:00:00.000Z");
  });

  it("load returns null for unknown graph id", async () => {
    const store = new SqliteTaskGraphStore();
    expect(await store.load("nope")).toBeNull();
  });
});
