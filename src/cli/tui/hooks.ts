/**
 * TUI data hooks.
 *
 * The TUI never writes to SQLite. Each hook opens a prepared query at mount,
 * polls on a timer, and exposes the latest snapshot + a `refresh()` thunk the
 * Footer can call for a manual refresh. On unmount every interval is cleared —
 * nothing outlives the render tree.
 *
 * Tests don't hit SQLite. They mount the `DataSourceContext` with a stub
 * source that returns deterministic arrays.
 */

import type { PlanStep, StepStatus, TaskGraph } from "@/agent/types";
import { db as defaultDb } from "@/db";
import type Database from "better-sqlite3";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

// ─── Public data shapes ─────────────────────────────────────────────────────

export interface InvocationRow {
  id: number;
  graphId: string;
  stepId: string;
  toolName: string;
  argsJson: string;
  error: string | null;
  durationMs: number | null;
  at: string;
}

export interface RunSummary {
  reasoner: {
    ticks: number;
    candidates: number;
    toolCalls: number;
    costUsdTicks: number;
    avgDurationMsEstimate: number;
  };
  consolidator: {
    total: number;
    completed: number;
    failed: number;
    queued: number;
    inProgress: number;
  };
}

// ─── DataSource interface ───────────────────────────────────────────────────

export interface TuiDataSource {
  listActiveTaskGraphs(): TaskGraph[];
  recentInvocations(limit: number): InvocationRow[];
  runSummary24h(): RunSummary;
}

// ─── SQLite-backed data source ──────────────────────────────────────────────

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

interface InvRow {
  id: number;
  graph_id: string;
  step_id: string;
  tool_name: string;
  args_json: string;
  error: string | null;
  duration_ms: number | null;
  at: string;
}

interface ReasonerRow {
  ticks: number;
  candidates: number;
  tool_calls: number;
  cost_ticks: number;
}

interface ConsolidatorRow {
  status: string;
  n: number;
}

function stepFromRow(r: StepRow): PlanStep {
  const step: PlanStep = {
    id: r.id,
    parentId: r.parent_id,
    goal: r.goal,
    allowedTools: JSON.parse(r.allowed_tools_json) as readonly string[],
    status: r.status as StepStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.started_at != null) step.startedAt = r.started_at;
  if (r.completed_at != null) step.completedAt = r.completed_at;
  if (r.error != null) step.error = r.error;
  return step;
}

export function makeSqliteDataSource(database?: Database.Database): TuiDataSource {
  const dbi = database ?? defaultDb();
  const qGraphs = dbi.prepare(
    "SELECT * FROM agent_task_graphs WHERE status IN ('pending','running') ORDER BY updated_at DESC LIMIT 20",
  );
  const qSteps = dbi.prepare("SELECT * FROM agent_task_steps WHERE graph_id = ? ORDER BY rowid");
  const qInvs = dbi.prepare(
    "SELECT id, graph_id, step_id, tool_name, args_json, error, duration_ms, at FROM agent_tool_invocations ORDER BY id DESC LIMIT ?",
  );
  const qReasoner = dbi.prepare(
    `SELECT
        COUNT(*) AS ticks,
        COALESCE(SUM(candidate_count), 0) AS candidates,
        COALESCE(SUM(tool_call_count), 0) AS tool_calls,
        COALESCE(SUM(cost_in_usd_ticks), 0) AS cost_ticks
     FROM reasoner_runs
     WHERE tick_at >= datetime('now','-24 hours')`,
  );
  const qConsolidator = dbi.prepare(
    `SELECT status, COUNT(*) AS n
     FROM consolidator_runs
     WHERE created_at >= datetime('now','-24 hours')
     GROUP BY status`,
  );

  return {
    listActiveTaskGraphs(): TaskGraph[] {
      const gRows = qGraphs.all() as GraphRow[];
      return gRows.map((g) => {
        const steps = (qSteps.all(g.id) as StepRow[]).map(stepFromRow);
        const graph: TaskGraph = {
          id: g.id,
          rootGoal: g.root_goal,
          status: g.status as StepStatus,
          steps,
          createdAt: g.created_at,
          updatedAt: g.updated_at,
        };
        if (g.metadata_json) {
          try {
            graph.metadata = JSON.parse(g.metadata_json) as Record<string, unknown>;
          } catch {
            // non-JSON metadata — ignore
          }
        }
        return graph;
      });
    },
    recentInvocations(limit: number): InvocationRow[] {
      const rows = qInvs.all(limit) as InvRow[];
      return rows.map((r) => ({
        id: r.id,
        graphId: r.graph_id,
        stepId: r.step_id,
        toolName: r.tool_name,
        argsJson: r.args_json,
        error: r.error,
        durationMs: r.duration_ms,
        at: r.at,
      }));
    },
    runSummary24h(): RunSummary {
      const r = qReasoner.get() as ReasonerRow | undefined;
      const cRows = qConsolidator.all() as ConsolidatorRow[];
      const byStatus = new Map(cRows.map((x) => [x.status, x.n]));
      const total = cRows.reduce((acc, x) => acc + x.n, 0);
      return {
        reasoner: {
          ticks: r?.ticks ?? 0,
          candidates: r?.candidates ?? 0,
          toolCalls: r?.tool_calls ?? 0,
          costUsdTicks: r?.cost_ticks ?? 0,
          avgDurationMsEstimate: 0,
        },
        consolidator: {
          total,
          completed: byStatus.get("completed") ?? 0,
          failed: byStatus.get("failed") ?? 0,
          queued: byStatus.get("queued") ?? 0,
          inProgress: byStatus.get("in_progress") ?? 0,
        },
      };
    },
  };
}

// ─── React context ──────────────────────────────────────────────────────────

export const DataSourceContext = createContext<TuiDataSource | null>(null);

function useDataSource(): TuiDataSource {
  const src = useContext(DataSourceContext);
  if (!src) throw new Error("TUI DataSourceContext not provided");
  return src;
}

// ─── Generic polling hook ───────────────────────────────────────────────────

interface PollState<T> {
  data: T;
  loading: boolean;
  refresh: () => void;
}

function usePolled<T>(fn: () => T, fallback: T, pollMs: number): PollState<T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Lazy initial state: call fn() synchronously on first render so the very
  // first frame already has real data. If the call throws, fall back.
  const [data, setData] = useState<T>(() => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  });
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useMemo(
    () => (): void => {
      try {
        setData(fnRef.current());
        setLoading(false);
      } catch {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const id = setInterval(refresh, Math.max(250, pollMs));
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { data, loading, refresh };
}

// ─── Public hooks ───────────────────────────────────────────────────────────

export function useTaskGraphs(pollMs = 2000): PollState<TaskGraph[]> {
  const src = useDataSource();
  return usePolled<TaskGraph[]>(() => src.listActiveTaskGraphs(), [], pollMs);
}

export function useRunSummary(pollMs = 5000): PollState<RunSummary> {
  const src = useDataSource();
  const initial: RunSummary = {
    reasoner: { ticks: 0, candidates: 0, toolCalls: 0, costUsdTicks: 0, avgDurationMsEstimate: 0 },
    consolidator: { total: 0, completed: 0, failed: 0, queued: 0, inProgress: 0 },
  };
  return usePolled<RunSummary>(() => src.runSummary24h(), initial, pollMs);
}

export function useRecentInvocations(limit = 50, pollMs = 1000): PollState<InvocationRow[]> {
  const src = useDataSource();
  return usePolled<InvocationRow[]>(() => src.recentInvocations(limit), [], pollMs);
}
