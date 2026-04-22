/**
 * Strand TUI — single-screen live view over the local SQLite ops DB.
 *
 * The TUI is read-only:
 *   - polls `agent_task_graphs` / `_steps` for active graphs
 *   - polls `agent_tool_invocations` for the recent-invocation stream
 *   - polls `reasoner_runs` + `consolidator_runs` for last-24h stats
 *
 * Every interval is registered inside the hook that owns it and cleared on
 * unmount. Nothing outlives the render tree.
 */

import { env } from "@/config";
import { Box, Text, render, useApp, useInput, useStdin } from "ink";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";
import { Footer, Header, InvocationsPane, RunSummaryPane, TaskGraphsPane } from "./components";
import {
  DataSourceContext,
  type TuiDataSource,
  makeSqliteDataSource,
  useRecentInvocations,
  useRunSummary,
  useTaskGraphs,
} from "./hooks";

// ─── App ────────────────────────────────────────────────────────────────────

export interface AppProps {
  pollMs?: number;
}

export function App({ pollMs = 2000 }: AppProps): ReactElement {
  const app = useApp();
  const { isRawModeSupported } = useStdin();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [focusedPane, setFocusedPane] = useState<"graphs" | "invocations">("graphs");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(Date.now());
  const [paused, setPaused] = useState(false);

  // Hooks manage their own intervals; we simply use their `refresh()` for
  // manual [r] refreshes.
  const graphs = useTaskGraphs(paused ? 10 * 60_000 : pollMs);
  const summary = useRunSummary(paused ? 10 * 60_000 : Math.max(pollMs * 2, 5000));
  const invocations = useRecentInvocations(50, paused ? 10 * 60_000 : Math.max(pollMs / 2, 1000));

  const refreshAll = useCallback((): void => {
    graphs.refresh();
    summary.refresh();
    invocations.refresh();
    setLastRefreshAt(Date.now());
  }, [graphs, summary, invocations]);

  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        app.exit();
        return;
      }
      if (input === "r") {
        refreshAll();
        return;
      }
      if (key.tab) {
        setFocusedPane((p) => (p === "graphs" ? "invocations" : "graphs"));
        return;
      }
      if (input === "p") {
        setPaused((p) => !p);
        return;
      }
      if (focusedPane === "graphs") {
        if (key.upArrow) {
          setSelectedIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIdx((i) => Math.min(Math.max(0, graphs.data.length - 1), i + 1));
          return;
        }
        if (key.return) {
          setExpanded((e) => !e);
          return;
        }
      } else {
        if (key.upArrow) {
          setScrollOffset((o) => Math.max(0, o - 1));
          return;
        }
        if (key.downArrow) {
          setScrollOffset((o) => Math.min(Math.max(0, invocations.data.length - 1), o + 1));
          return;
        }
      }
    },
    { isActive: Boolean(isRawModeSupported) },
  );

  const header = useMemo(
    () => ({
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL_REASONER,
      mode: env.STRAND_MODE,
      credentialStore: process.env["STRAND_CREDENTIAL_STORE"] ?? "env",
      tenant: process.env["STRAND_TENANT"] ?? null,
    }),
    [],
  );

  return (
    <Box flexDirection="column">
      <Header {...header} />
      {!isRawModeSupported ? (
        <Box paddingX={1}>
          <Text color="yellow">
            {
              "[non-TTY] keyboard input disabled — refresh/select/quit unavailable. Run in a real terminal."
            }
          </Text>
        </Box>
      ) : null}
      {paused ? (
        <Box paddingX={1}>
          <Text color="yellow">{"[paused] — press p to resume, r to refresh once"}</Text>
        </Box>
      ) : null}
      <TaskGraphsPane
        graphs={graphs.data}
        loading={graphs.loading}
        selectedIdx={Math.min(selectedIdx, Math.max(0, graphs.data.length - 1))}
        expanded={expanded}
        focused={focusedPane === "graphs"}
      />
      <RunSummaryPane summary={summary.data} loading={summary.loading} />
      <InvocationsPane
        rows={invocations.data}
        loading={invocations.loading}
        focused={focusedPane === "invocations"}
        scrollOffset={scrollOffset}
      />
      <Footer focusedPane={focusedPane} lastRefreshAt={lastRefreshAt} />
    </Box>
  );
}

// ─── Entry point ────────────────────────────────────────────────────────────

export interface LaunchTuiOpts {
  pollMs?: number;
  /** Test hook: inject a stub data source instead of opening SQLite. */
  dataSource?: TuiDataSource;
}

export async function launchTui(opts: LaunchTuiOpts = {}): Promise<void> {
  const source = opts.dataSource ?? makeSqliteDataSource();
  const instance = render(
    <DataSourceContext.Provider value={source}>
      <App {...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {})} />
    </DataSourceContext.Provider>,
  );
  await instance.waitUntilExit();
}
