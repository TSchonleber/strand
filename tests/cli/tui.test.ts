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
import { HELP_ENTRIES, HelpPanel } from "@/cli/tui/components";
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
  it("renders a non-empty frame with mocked data", () => {
    const source = makeStubSource();
    const tree = createElement(
      DataSourceContext.Provider,
      { value: source },
      createElement(Dashboard, { pollMs: 10_000 }),
    );
    const { lastFrame, unmount } = render(tree);

    const frame = lastFrame() ?? "";
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
    // Footer hint — condensed with help shortcut
    expect(frame).toContain("[q] quit");
    expect(frame).toContain("[?] help");

    unmount();
  });

  it("HelpPanel renders all keyboard shortcut entries", () => {
    const { lastFrame, unmount } = render(createElement(HelpPanel));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("keyboard shortcuts");
    for (const entry of HELP_ENTRIES) {
      expect(frame).toContain(entry.key);
      expect(frame).toContain(entry.desc);
    }
    expect(frame).toContain("Press ? to close");
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
    expect(frame).toContain("Strand TUI");
    expect(frame).toContain("(no active graphs)");
    expect(frame).toContain("(no invocations yet)");
    unmount();
  });
});
