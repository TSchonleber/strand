/**
 * Persistent TaskGraph store backed by the local SQLite DB.
 *
 * A TaskGraph is a tree of PlanSteps the agent is working through. The store
 * persists graphs + steps + every tool invocation, so a runner that crashes
 * mid-step can be resumed from disk by a sweeper.
 *
 * Schema lives in `src/db/schema.sql`. This file owns serialization and the
 * narrow CRUD surface described by `TaskGraphStore` in `./types.ts`.
 */

import { randomUUID } from "node:crypto";
import { db as defaultDb } from "@/db";
import type Database from "better-sqlite3";
import type {
  BudgetLimits,
  PlanStep,
  StepStatus,
  TaskGraph,
  TaskGraphStore,
  ToolInvocation,
} from "./types";

// ─── Row shapes ─────────────────────────────────────────────────────────────

interface GraphRow {
  id: string;
  root_goal: string;
  status: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  graph_id: string;
  parent_id: string | null;
  goal: string;
  allowed_tools_json: string;
  max_iterations: number | null;
  budget_json: string | null;
  status: string;
  result_json: string | null;
  error: string | null;
  reflection: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ─── Row ↔ domain conversions ───────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function rowToStep(r: StepRow): PlanStep {
  const step: PlanStep = {
    id: r.id,
    parentId: r.parent_id,
    goal: r.goal,
    allowedTools: JSON.parse(r.allowed_tools_json) as readonly string[],
    status: r.status as StepStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.max_iterations != null) step.maxIterations = r.max_iterations;
  if (r.budget_json != null) step.budget = JSON.parse(r.budget_json) as Partial<BudgetLimits>;
  if (r.result_json != null) step.result = JSON.parse(r.result_json);
  if (r.error != null) step.error = r.error;
  if (r.reflection != null) step.reflection = r.reflection;
  if (r.started_at != null) step.startedAt = r.started_at;
  if (r.completed_at != null) step.completedAt = r.completed_at;
  return step;
}

function rowToGraph(g: GraphRow, steps: PlanStep[]): TaskGraph {
  const graph: TaskGraph = {
    id: g.id,
    rootGoal: g.root_goal,
    status: g.status as StepStatus,
    steps,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
  if (g.metadata_json != null) {
    graph.metadata = JSON.parse(g.metadata_json) as Record<string, unknown>;
  }
  return graph;
}

// ─── Factory: createTaskGraph ───────────────────────────────────────────────

export function createTaskGraph(args: {
  rootGoal: string;
  steps: Omit<PlanStep, "id" | "parentId" | "status" | "createdAt" | "updatedAt">[];
  metadata?: Record<string, unknown>;
}): TaskGraph {
  const now = nowIso();
  const graphId = randomUUID();
  const steps: PlanStep[] = args.steps.map((s) => {
    const step: PlanStep = {
      id: randomUUID(),
      parentId: null,
      goal: s.goal,
      allowedTools: s.allowedTools,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    if (s.maxIterations !== undefined) step.maxIterations = s.maxIterations;
    if (s.budget !== undefined) step.budget = s.budget;
    return step;
  });
  const graph: TaskGraph = {
    id: graphId,
    rootGoal: args.rootGoal,
    status: "pending",
    steps,
    createdAt: now,
    updatedAt: now,
  };
  if (args.metadata !== undefined) graph.metadata = args.metadata;
  return graph;
}

// ─── Resume helper ──────────────────────────────────────────────────────────

/**
 * Load a graph and pick the next step to execute:
 *   - a `running` step wins (process died mid-step — resume it)
 *   - otherwise the first `pending` step in insertion order
 *   - otherwise null (graph is effectively done)
 */
export async function resumeTaskGraph(
  store: TaskGraphStore,
  graphId: string,
): Promise<{ graph: TaskGraph; nextStep: PlanStep | null }> {
  const graph = await store.load(graphId);
  if (!graph) throw new Error(`task graph not found: ${graphId}`);
  const running = graph.steps.find((s) => s.status === "running");
  if (running) return { graph, nextStep: running };
  const pending = graph.steps.find((s) => s.status === "pending");
  return { graph, nextStep: pending ?? null };
}

// ─── SqliteTaskGraphStore ───────────────────────────────────────────────────

export class SqliteTaskGraphStore implements TaskGraphStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database = defaultDb()) {
    this.db = db;
  }

  async save(graph: TaskGraph): Promise<void> {
    const upsertGraph = this.db.prepare(`
      INSERT INTO agent_task_graphs (id, root_goal, status, metadata_json, created_at, updated_at)
      VALUES (@id, @root_goal, @status, @metadata_json, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        root_goal = excluded.root_goal,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    const upsertStep = this.db.prepare(`
      INSERT INTO agent_task_steps (
        id, graph_id, parent_id, goal, allowed_tools_json, max_iterations, budget_json,
        status, result_json, error, reflection, created_at, updated_at, started_at, completed_at
      ) VALUES (
        @id, @graph_id, @parent_id, @goal, @allowed_tools_json, @max_iterations, @budget_json,
        @status, @result_json, @error, @reflection, @created_at, @updated_at, @started_at, @completed_at
      )
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        goal = excluded.goal,
        allowed_tools_json = excluded.allowed_tools_json,
        max_iterations = excluded.max_iterations,
        budget_json = excluded.budget_json,
        status = excluded.status,
        result_json = excluded.result_json,
        error = excluded.error,
        reflection = excluded.reflection,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `);

    const tx = this.db.transaction((g: TaskGraph) => {
      upsertGraph.run({
        id: g.id,
        root_goal: g.rootGoal,
        status: g.status,
        metadata_json: g.metadata ? JSON.stringify(g.metadata) : null,
        created_at: g.createdAt,
        updated_at: g.updatedAt,
      });
      for (const s of g.steps) {
        upsertStep.run({
          id: s.id,
          graph_id: g.id,
          parent_id: s.parentId,
          goal: s.goal,
          allowed_tools_json: JSON.stringify(s.allowedTools),
          max_iterations: s.maxIterations ?? null,
          budget_json: s.budget ? JSON.stringify(s.budget) : null,
          status: s.status,
          result_json: s.result !== undefined ? JSON.stringify(s.result) : null,
          error: s.error ?? null,
          reflection: s.reflection ?? null,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
          started_at: s.startedAt ?? null,
          completed_at: s.completedAt ?? null,
        });
      }
    });
    tx(graph);
  }

  async load(id: string): Promise<TaskGraph | null> {
    const gRow = this.db.prepare("SELECT * FROM agent_task_graphs WHERE id = ?").get(id) as
      | GraphRow
      | undefined;
    if (!gRow) return null;
    const stepRows = this.db
      .prepare("SELECT * FROM agent_task_steps WHERE graph_id = ? ORDER BY rowid")
      .all(id) as StepRow[];
    return rowToGraph(gRow, stepRows.map(rowToStep));
  }

  async updateStep(graphId: string, step: PlanStep): Promise<void> {
    const now = nowIso();
    const stmt = this.db.prepare(`
      UPDATE agent_task_steps SET
        status = @status,
        result_json = @result_json,
        error = @error,
        reflection = @reflection,
        updated_at = @updated_at,
        started_at = @started_at,
        completed_at = @completed_at
      WHERE id = @id AND graph_id = @graph_id
    `);
    stmt.run({
      id: step.id,
      graph_id: graphId,
      status: step.status,
      result_json: step.result !== undefined ? JSON.stringify(step.result) : null,
      error: step.error ?? null,
      reflection: step.reflection ?? null,
      updated_at: now,
      started_at: step.startedAt ?? null,
      completed_at: step.completedAt ?? null,
    });
    this.db.prepare("UPDATE agent_task_graphs SET updated_at = ? WHERE id = ?").run(now, graphId);
  }

  async listByStatus(status: StepStatus, limit = 50): Promise<TaskGraph[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_task_graphs WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
      .all(status, limit) as GraphRow[];
    const stepStmt = this.db.prepare(
      "SELECT * FROM agent_task_steps WHERE graph_id = ? ORDER BY rowid",
    );
    return rows.map((g) => {
      const steps = (stepStmt.all(g.id) as StepRow[]).map(rowToStep);
      return rowToGraph(g, steps);
    });
  }

  async appendInvocation(graphId: string, stepId: string, inv: ToolInvocation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_tool_invocations (
           graph_id, step_id, tool_name, args_json, result_json, error, duration_ms, at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        graphId,
        stepId,
        inv.name,
        JSON.stringify(inv.args ?? null),
        inv.result !== undefined ? JSON.stringify(inv.result) : null,
        inv.error ?? null,
        inv.durationMs ?? null,
        new Date(inv.at).toISOString(),
      );
  }
}
