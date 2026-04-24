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
import { COLS, Header, badge, formatKV, pad, sectionLine, truncate } from "@/cli/tui/components";
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

// ─── Layout helper unit tests ─────────────────────────────────────────────

describe("layout helpers", () => {
  it("truncate clips long strings with ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello w\u2026");
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("exact", 5)).toBe("exact");
  });

  it("pad right-pads to target width", () => {
    expect(pad("hi", 5)).toBe("hi   ");
    expect(pad("hello", 3)).toBe("hello");
  });

  it("formatKV builds fixed-width key-value pairs", () => {
    const kv = formatKV("mode", "shadow", 10);
    expect(kv).toBe("mode: shadow    ");
    expect(kv).toHaveLength(16);
  });

  it("formatKV truncates long values", () => {
    const kv = formatKV("provider", "xai/grok-4.20-reasoning-super-long-model-name", 20);
    expect(kv).toHaveLength(30);
    expect(kv).toContain("\u2026");
  });

  it("badge builds compact count+label", () => {
    expect(badge(42, "ticks", 12)).toBe("42 ticks    ");
    expect(badge(0, "wip", 7)).toBe("0 wip  ");
  });

  it("sectionLine fills to COLS with dashes", () => {
    const line = sectionLine("test");
    expect(line).toHaveLength(COLS);
    expect(line).toMatch(/^\u2500\u2500\u2500 test \u2500+$/);
  });

  it("sectionLine with empty title produces plain rule", () => {
    const line = sectionLine("");
    expect(line).toHaveLength(COLS);
    expect(line).toMatch(/^\u2500+$/);
  });
});

// ─── Cockpit header rendering ─────────────────────────────────────────────

describe("cockpit header", () => {
  it("renders provider and mode on a single stable line", () => {
    const tree = createElement(Header, {
      provider: "xai",
      model: "grok-4.20-reasoning",
      mode: "shadow",
      credentialStore: "env",
      tenant: null,
    });
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Strand TUI");
    expect(frame).toContain("provider:");
    expect(frame).toContain("xai/grok-4.20-reasoning");
    expect(frame).toContain("mode:");
    expect(frame).toContain("shadow");
    expect(frame).toContain("store:");

    const lines = frame.split("\n");
    const providerLine = lines.find((l) => l.includes("provider:"));
    expect(providerLine).toBeDefined();
    expect(providerLine).toContain("mode:");

    unmount();
  });

  it("truncates long provider/model with ellipsis", () => {
    const tree = createElement(Header, {
      provider: "openai-compatible",
      model: "some-very-long-model-name-that-exceeds-budget",
      mode: "gated",
      credentialStore: "file",
      tenant: "acme",
    });
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("\u2026");
    expect(frame).not.toContain("some-very-long-model-name-that-exceeds-budget");
    expect(frame).toContain("gated");
    expect(frame).toContain("acme");

    unmount();
  });

  it("section dividers span full width", () => {
    const tree = createElement(Header, {
      provider: "xai",
      model: "grok",
      mode: "shadow",
      credentialStore: "env",
      tenant: null,
    });
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";

    const lines = frame.split("\n");
    const ruleLine = lines.find((l) => /^\u2500{10,}$/.test(l.trim()));
    expect(ruleLine).toBeDefined();

    unmount();
  });
});

// ─── Dashboard smoke tests ────────────────────────────────────────────────

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
    expect(frame).toContain("Strand TUI");
    expect(frame).toContain("(no active graphs)");
    expect(frame).toContain("(no invocations yet)");
    unmount();
  });
});
