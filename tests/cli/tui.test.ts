/**
 * TUI smoke tests.
 *
 * We don't exercise real SQLite polling — we inject a stub TuiDataSource via
 * DataSourceContext and render the tree with ink-testing-library, then assert
 * the output string contains the pieces we care about.
 *
 * This is deliberately minimal: if the TUI imports cleanly and renders a
 * non-empty frame with mocked data, that's the bar for this pass.
 */

import type { TaskGraph } from "@/agent/types";
import {
  DataSourceContext,
  type InvocationRow,
  type OperatorSnapshot,
  type RunSummary,
  type TuiDataSource,
  type XHealthEntry,
} from "@/cli/tui/hooks";
import { Dashboard } from "@/cli/tui/index";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStubSource(): TuiDataSource {
  const graph: TaskGraph = {
    id: "7e3c1234-abcd-4000-8000-000000000000",
    rootGoal: "crawl site X and summarize",
    status: "running",
    createdAt: "2026-04-20T15:00:00.000Z",
    updatedAt: "2026-04-20T15:04:00.000Z",
    steps: [
      {
        id: "s1",
        parentId: null,
        goal: "fetch home page",
        allowedTools: ["http_fetch"],
        status: "completed",
        createdAt: "2026-04-20T15:00:00.000Z",
        updatedAt: "2026-04-20T15:00:05.000Z",
        startedAt: "2026-04-20T15:00:00.000Z",
        completedAt: "2026-04-20T15:00:02.300Z",
      },
      {
        id: "s2",
        parentId: null,
        goal: "summarize",
        allowedTools: ["llm_summarize"],
        status: "running",
        createdAt: "2026-04-20T15:00:05.000Z",
        updatedAt: "2026-04-20T15:00:05.000Z",
        startedAt: "2026-04-20T15:00:05.000Z",
      },
    ],
  };

  const invocations: InvocationRow[] = [
    {
      id: 3,
      graphId: graph.id,
      stepId: "s2",
      toolName: "http_fetch",
      argsJson: '{"url":"example.com"}',
      error: null,
      durationMs: 182,
      at: "2026-04-20T15:04:14.000Z",
    },
    {
      id: 2,
      graphId: graph.id,
      stepId: "s1",
      toolName: "fs_read",
      argsJson: '{"path":"/src/index.ts"}',
      error: null,
      durationMs: 3,
      at: "2026-04-20T15:04:12.000Z",
    },
  ];

  const summary: RunSummary = {
    reasoner: {
      ticks: 42,
      candidates: 156,
      toolCalls: 9,
      costUsdTicks: 1_800_000_000, // $0.18
      avgDurationMsEstimate: 2300,
    },
    consolidator: { total: 7, completed: 2, failed: 1, queued: 4, inProgress: 0 },
  };

  const health: XHealthEntry[] = [
    {
      kind: "reply",
      lastStatus: "executed",
      lastErrorCode: null,
      lastAt: "2026-04-20T15:03:00.000Z",
      ok24h: 12,
      fail24h: 0,
    },
    {
      kind: "like",
      lastStatus: "failed",
      lastErrorCode: "429",
      lastAt: "2026-04-20T15:02:00.000Z",
      ok24h: 30,
      fail24h: 2,
    },
  ];

  return {
    listActiveTaskGraphs: () => [graph],
    recentInvocations: () => invocations,
    runSummary24h: () => summary,
    xHealth: () => health,
  };
}

function makeEmptySource(): TuiDataSource {
  return {
    listActiveTaskGraphs: () => [],
    recentInvocations: () => [],
    runSummary24h: () => ({
      reasoner: {
        ticks: 0,
        candidates: 0,
        toolCalls: 0,
        costUsdTicks: 0,
        avgDurationMsEstimate: 0,
      },
      consolidator: { total: 0, completed: 0, failed: 0, queued: 0, inProgress: 0 },
    }),
    xHealth: () => [],
  };
}

function renderDashboard(source: TuiDataSource): { frame: string; unmount: () => void } {
  const tree = createElement(
    DataSourceContext.Provider,
    { value: source },
    createElement(Dashboard, { pollMs: 10_000 }),
  );
  const { lastFrame, unmount } = render(tree);
  return { frame: lastFrame() ?? "", unmount };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("strand tui dashboard", () => {
  it("renders a non-empty frame with mocked data", () => {
    const source = makeStubSource();
    const { frame, unmount } = renderDashboard(source);

    expect(frame.length).toBeGreaterThan(0);
    // Header renders provider + mode
    expect(frame).toContain("Strand TUI");
    expect(frame).toContain("shadow");
    // A fake graph appears
    expect(frame).toContain("crawl site X and summarize");
    expect(frame).toContain("fetch home page");
    // Invocations pane shows a tool line
    expect(frame).toContain("http_fetch");
    expect(frame).toContain("fs_read");
    // Run summary pane shows reasoner ticks + cost
    expect(frame).toContain("42 ticks");
    expect(frame).toContain("$0.18");
    // Consolidator counts
    expect(frame).toContain("7 runs");
    // Footer hint
    expect(frame).toContain("[q] quit");

    unmount();
  });

  it("does not crash when data sources return empty", () => {
    const { frame, unmount } = renderDashboard(makeEmptySource());

    expect(frame).toContain("Strand TUI");
    expect(frame).toContain("(no active graphs)");
    expect(frame).toContain("(no invocations yet)");
    // Reasoner 0 ticks renders cleanly (no NaN)
    expect(frame).not.toContain("NaN");
    expect(frame).toContain("0 ticks");
    expect(frame).toContain("$0.00");
    // Consolidator zero
    expect(frame).toContain("0 runs");

    unmount();
  });

  it("no NaN in rendered output for populated data", () => {
    const { frame, unmount } = renderDashboard(makeStubSource());
    expect(frame).not.toContain("NaN");
    unmount();
  });
});

// ─── OperatorSnapshot shape ─────────────────────────────────────────────────

describe("OperatorSnapshot shape", () => {
  it("assembles all fields from a populated source", () => {
    const source = makeStubSource();
    const snap: OperatorSnapshot = {
      graphs: source.listActiveTaskGraphs(),
      invocations: source.recentInvocations(50),
      summary: source.runSummary24h(),
      xHealth: source.xHealth(),
    };
    expect(snap.graphs).toHaveLength(1);
    expect(snap.invocations).toHaveLength(2);
    expect(snap.summary.reasoner.ticks).toBe(42);
    expect(snap.xHealth).toHaveLength(2);
    expect(snap.xHealth[0]?.kind).toBe("reply");
    expect(snap.xHealth[1]?.lastErrorCode).toBe("429");
  });

  it("assembles cleanly from an empty source", () => {
    const source = makeEmptySource();
    const snap: OperatorSnapshot = {
      graphs: source.listActiveTaskGraphs(),
      invocations: source.recentInvocations(50),
      summary: source.runSummary24h(),
      xHealth: source.xHealth(),
    };
    expect(snap.graphs).toHaveLength(0);
    expect(snap.invocations).toHaveLength(0);
    expect(snap.summary.reasoner.ticks).toBe(0);
    expect(snap.summary.reasoner.costUsdTicks).toBe(0);
    expect(snap.summary.consolidator.total).toBe(0);
    expect(snap.xHealth).toHaveLength(0);
  });
});

// ─── X health dedup ─────────────────────────────────────────────────────────

describe("X health dedup", () => {
  it("returns one entry per kind (no duplicates)", () => {
    const source = makeStubSource();
    const health = source.xHealth();
    const kinds = health.map((h) => h.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("returns empty array from empty source", () => {
    const source = makeEmptySource();
    expect(source.xHealth()).toEqual([]);
  });

  it("includes ok/fail counts", () => {
    const source = makeStubSource();
    const health = source.xHealth();
    for (const entry of health) {
      expect(typeof entry.ok24h).toBe("number");
      expect(typeof entry.fail24h).toBe("number");
      expect(Number.isFinite(entry.ok24h)).toBe(true);
      expect(Number.isFinite(entry.fail24h)).toBe(true);
    }
  });
});
