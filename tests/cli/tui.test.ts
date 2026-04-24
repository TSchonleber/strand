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
  type RunSummary,
  type TuiDataSource,
} from "@/cli/tui/hooks";
import { Dashboard } from "@/cli/tui/index";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

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

  return {
    listActiveTaskGraphs: () => [graph],
    recentInvocations: () => invocations,
    runSummary24h: () => summary,
  };
}

describe("strand tui dashboard", () => {
  it("renders cockpit panels with mocked data", () => {
    const source = makeStubSource();
    const tree = createElement(
      DataSourceContext.Provider,
      { value: source },
      createElement(Dashboard, { pollMs: 10_000 }),
    );
    const { lastFrame, unmount } = render(tree);

    const frame = lastFrame() ?? "";
    expect(frame.length).toBeGreaterThan(0);

    // Cockpit banner
    expect(frame).toContain("Strand");
    expect(frame).toContain("operator cockpit");

    // Mission panel
    expect(frame).toContain("MISSION");
    expect(frame).toContain("shadow");
    expect(frame).toContain("HALT");

    // Safety Shield panel
    expect(frame).toContain("SAFETY SHIELD");
    expect(frame).toContain("queued");
    expect(frame).toContain("7 runs");

    // Pulse panel
    expect(frame).toContain("PULSE");
    expect(frame).toContain("42 ticks");
    expect(frame).toContain("$0.18");

    // Reach panel
    expect(frame).toContain("REACH");

    // Task graph still renders
    expect(frame).toContain("crawl site X and summarize");
    expect(frame).toContain("fetch home page");

    // Invocations pane shows tool lines
    expect(frame).toContain("http_fetch");
    expect(frame).toContain("fs_read");

    // Footer hint
    expect(frame).toContain("[q] quit");

    unmount();
  });

  it("does not crash when data sources return empty", () => {
    const empty: TuiDataSource = {
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
    };
    const tree = createElement(
      DataSourceContext.Provider,
      { value: empty },
      createElement(Dashboard, { pollMs: 10_000 }),
    );
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";
    // Cockpit panels still render
    expect(frame).toContain("MISSION");
    expect(frame).toContain("SAFETY SHIELD");
    expect(frame).toContain("PULSE");
    expect(frame).toContain("REACH");
    // Empty state for data panes
    expect(frame).toContain("(no active graphs)");
    expect(frame).toContain("(no invocations yet)");
    unmount();
  });

  it("renders ASCII bars in pulse panel", () => {
    const source = makeStubSource();
    const tree = createElement(
      DataSourceContext.Provider,
      { value: source },
      createElement(Dashboard, { pollMs: 10_000 }),
    );
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";
    // ASCII bars use # and ─ characters
    expect(frame).toMatch(/\[#+─*\]/);
    unmount();
  });

  it("shows safety indicators with correct severity", () => {
    const source = makeStubSource();
    const tree = createElement(
      DataSourceContext.Provider,
      { value: source },
      createElement(Dashboard, { pollMs: 10_000 }),
    );
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";
    // DLQ count appears
    expect(frame).toContain("1 failed");
    // Queued count appears
    expect(frame).toContain("4 queued");
    unmount();
  });
});
