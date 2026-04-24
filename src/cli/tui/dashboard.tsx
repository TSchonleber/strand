/**
 * Strand cockpit — the operator command center behind `strand tui --dashboard`.
 *
 * Single-screen read-only tree over the local SQLite ops DB:
 *   - polls `agent_task_graphs` / `_steps` for active graphs
 *   - polls `agent_tool_invocations` for the recent-invocation stream
 *   - polls `reasoner_runs` + `consolidator_runs` for last-24h stats
 *
 * Every interval is registered inside the hook that owns it and cleared on
 * unmount. Nothing outlives the render tree.
 */

import { env } from "@/config";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";
import {
  CockpitBanner,
  Footer,
  InvocationsPane,
  MissionPanel,
  PulsePanel,
  ReachPanel,
  SafetyShieldPanel,
  TaskGraphsPane,
} from "./components";
import { useRecentInvocations, useRunSummary, useTaskGraphs } from "./hooks";

export interface DashboardProps {
  pollMs?: number;
  onWelcome?: () => void;
}

export function Dashboard({ pollMs = 2000, onWelcome }: DashboardProps): ReactElement {
  const app = useApp();
  const { isRawModeSupported } = useStdin();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [focusedPane, setFocusedPane] = useState<"graphs" | "invocations">("graphs");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(Date.now());
  const [paused, setPaused] = useState(false);

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
      if (input === "w" && onWelcome) {
        onWelcome();
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

  const r = summary.data.reasoner;
  const c = summary.data.consolidator;

  return (
    <Box flexDirection="column">
      <CockpitBanner />
      {!isRawModeSupported ? (
        <Box paddingX={1}>
          <Text color="yellow">
            {"[non-TTY] keyboard input disabled — run in a real terminal."}
          </Text>
        </Box>
      ) : null}
      {paused ? (
        <Box paddingX={1}>
          <Text color="yellow">{"[paused] — press p to resume, r to refresh once"}</Text>
        </Box>
      ) : null}
      {/* ── Cockpit top row ── */}
      <Box flexDirection="row">
        <MissionPanel
          mode={env.STRAND_MODE}
          halt={env.STRAND_HALT}
          tier={env.TIER}
          provider={env.LLM_PROVIDER}
          model={env.LLM_MODEL_REASONER}
        />
        <SafetyShieldPanel
          reviewQueued={c.queued}
          reviewActive={c.inProgress}
          dlqFailed={c.failed}
          totalRuns={c.total}
          completedRuns={c.completed}
        />
      </Box>
      {/* ── Cockpit bottom row ── */}
      <Box flexDirection="row">
        <PulsePanel
          ticks={r.ticks}
          candidates={r.candidates}
          toolCalls={r.toolCalls}
          costUsdTicks={r.costUsdTicks}
        />
        <ReachPanel />
      </Box>
      {/* ── Live data panes ── */}
      <TaskGraphsPane
        graphs={graphs.data}
        loading={graphs.loading}
        selectedIdx={Math.min(selectedIdx, Math.max(0, graphs.data.length - 1))}
        expanded={expanded}
        focused={focusedPane === "graphs"}
      />
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
