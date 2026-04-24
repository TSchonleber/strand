/**
 * Stateless presentational components for the Strand TUI.
 *
 * Every piece of data is passed in as props — no hook calls here, no side
 * effects. Makes these trivial to render in tests with whatever mock data we
 * want.
 */

import type { PlanStep, StepStatus, TaskGraph } from "@/agent/types";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ReactElement } from "react";
import type { InvocationRow, RunSummary } from "./hooks";

// ─── Visual helpers ─────────────────────────────────────────────────────────

function statusGlyph(s: StepStatus): string {
  switch (s) {
    case "completed":
      return "\u2713";
    case "running":
      return "\u27F3";
    case "failed":
      return "\u2717";
    case "skipped":
      return "\u2192";
    case "abandoned":
      return "\u00D7";
    case "pending":
      return "·";
  }
}

function statusColor(s: StepStatus): string {
  switch (s) {
    case "completed":
      return "green";
    case "running":
      return "cyan";
    case "failed":
      return "red";
    case "skipped":
      return "gray";
    case "abandoned":
      return "magenta";
    case "pending":
      return "gray";
  }
}

function shortId(id: string): string {
  return id.length > 4 ? `${id.slice(0, 4)}\u2026` : id;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso.slice(11, 19);
  }
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "\u2014";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsdFromTicks(ticks: number): string {
  // 1 tick = 1e-10 USD.
  const usd = ticks / 1e10;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ─── Layout helpers (fixed-width cockpit) ───────────────────────────────────

/** Cockpit content width: 80 cols minus paddingX=1 on each side. */
export const COLS = 78;

/** Truncate to n chars; append ellipsis if clipped. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}\u2026`;
}

/** Right-pad to exactly n chars (no-op if already wider). */
export function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

/** "label: value" with value truncated+padded to valueWidth. */
export function formatKV(label: string, value: string, valueWidth: number): string {
  return `${label}: ${pad(truncate(value, valueWidth), valueWidth)}`;
}

/** Compact badge: "count label" padded to width. */
export function badge(count: number | string, label: string, width: number): string {
  return pad(`${count} ${label}`, width);
}

/** Section divider filling width: "─── title ───────…" */
export function sectionLine(title: string, width: number = COLS): string {
  if (!title) return "\u2500".repeat(width);
  const prefix = `\u2500\u2500\u2500 ${title} `;
  if (prefix.length >= width) return prefix.slice(0, width);
  return prefix + "\u2500".repeat(width - prefix.length);
}

// ─── Header ─────────────────────────────────────────────────────────────────

export interface HeaderProps {
  provider: string;
  model: string;
  mode: string;
  credentialStore: string;
  tenant: string | null;
}

export function Header(props: HeaderProps): ReactElement {
  const pv = truncate(`${props.provider}/${props.model}`, 28);
  const modeColor = props.mode === "live" ? "red" : props.mode === "gated" ? "yellow" : "green";
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Text>
        <Text bold color="magenta">
          {"Strand TUI"}
        </Text>
        <Text color="gray">{" \u2014 live agent harness"}</Text>
      </Text>
      <Text>
        <Text color="gray">{"provider: "}</Text>
        <Text color="white">{pad(pv, 28)}</Text>
        <Text color="gray">{"  mode: "}</Text>
        <Text color={modeColor}>{props.mode}</Text>
      </Text>
      <Text>
        <Text color="gray">{"store: "}</Text>
        <Text>{pad(props.credentialStore, 8)}</Text>
        <Text color="gray">{"  tenant: "}</Text>
        <Text>{props.tenant ?? "\u2014"}</Text>
      </Text>
      <Text color="gray">{sectionLine("")}</Text>
    </Box>
  );
}

// ─── TaskGraphsPane ─────────────────────────────────────────────────────────

export interface TaskGraphsPaneProps {
  graphs: TaskGraph[];
  loading: boolean;
  selectedIdx: number;
  expanded: boolean;
  focused: boolean;
}

function StepLine({ step }: { step: PlanStep }): ReactElement {
  const glyph = statusGlyph(step.status);
  const color = statusColor(step.status);
  const duration =
    step.startedAt && step.completedAt
      ? fmtDuration(new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime())
      : step.startedAt
        ? fmtDuration(Date.now() - new Date(step.startedAt).getTime())
        : null;
  return (
    <Box>
      <Text color={color}> {glyph} </Text>
      <Text>{step.status.padEnd(9, " ")}</Text>
      <Text color="white"> {step.goal.slice(0, 48)}</Text>
      {duration ? <Text color="gray"> ({duration})</Text> : null}
      {step.error ? <Text color="red"> error: {step.error.slice(0, 32)}</Text> : null}
    </Box>
  );
}

function GraphLine({ g, selected }: { g: TaskGraph; selected: boolean }): ReactElement {
  const total = g.steps.length;
  const done = g.steps.filter((s) => s.status === "completed").length;
  const running = g.steps.some((s) => s.status === "running");
  const cursor = selected ? ">" : " ";
  return (
    <Box>
      <Text color={selected ? "cyan" : "white"}>{cursor} </Text>
      <Text color="gray">{shortId(g.id)} </Text>
      <Text color={statusColor(g.status)}>{g.status.padEnd(10, " ")}</Text>
      <Text>"{g.rootGoal.slice(0, 42)}"</Text>
      <Text color="gray">
        {" "}
        {done} / {total} steps
      </Text>
      {running ? (
        <Text color="cyan">
          {" "}
          <Spinner type="dots" />
        </Text>
      ) : null}
    </Box>
  );
}

export function TaskGraphsPane(props: TaskGraphsPaneProps): ReactElement {
  const heading = `active task graphs${props.focused ? " [focused]" : ""}`;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={props.focused ? "cyan" : "gray"}>{sectionLine(heading)}</Text>
      {props.loading && props.graphs.length === 0 ? (
        <Box>
          <Text color="gray">
            <Spinner type="dots" /> loading…
          </Text>
        </Box>
      ) : props.graphs.length === 0 ? (
        <Text color="gray"> (no active graphs)</Text>
      ) : (
        props.graphs.map((g, i) => (
          <Box key={g.id} flexDirection="column">
            <GraphLine g={g} selected={i === props.selectedIdx} />
            {props.expanded && i === props.selectedIdx
              ? g.steps.map((s) => <StepLine key={s.id} step={s} />)
              : null}
          </Box>
        ))
      )}
    </Box>
  );
}

// ─── RunSummaryPane ─────────────────────────────────────────────────────────

export interface RunSummaryPaneProps {
  summary: RunSummary;
  loading: boolean;
}

export function RunSummaryPane(props: RunSummaryPaneProps): ReactElement {
  const r = props.summary.reasoner;
  const c = props.summary.consolidator;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="gray">{sectionLine("recent runs (24h)")}</Text>
      <Text>
        <Text color="gray">{pad("reasoner", 13)}</Text>
        <Text>{badge(r.ticks, "ticks", 12)}</Text>
        <Text>{badge(r.candidates, "cands", 12)}</Text>
        <Text>{badge(r.toolCalls, "tools", 12)}</Text>
        <Text color="yellow">{fmtUsdFromTicks(r.costUsdTicks)}</Text>
      </Text>
      <Text>
        <Text color="gray">{pad("consolidator", 13)}</Text>
        <Text>{badge(c.total, "runs", 10)}</Text>
        <Text color="green">{badge(c.completed, "ok", 7)}</Text>
        <Text color="red">{badge(c.failed, "fail", 8)}</Text>
        <Text color="cyan">{badge(c.inProgress, "wip", 7)}</Text>
        <Text color="gray">{badge(c.queued, "queued", 10)}</Text>
      </Text>
    </Box>
  );
}

// ─── InvocationsPane ────────────────────────────────────────────────────────

export interface InvocationsPaneProps {
  rows: InvocationRow[];
  loading: boolean;
  focused: boolean;
  scrollOffset: number;
  maxRows?: number;
}

export function InvocationsPane(props: InvocationsPaneProps): ReactElement {
  const maxRows = props.maxRows ?? 8;
  const total = props.rows.length;
  const start = Math.min(Math.max(0, props.scrollOffset), Math.max(0, total - 1));
  const visible = props.rows.slice(start, start + maxRows);

  const focusTag = props.focused ? " [focused]" : "";
  const invTitle = `tool invocations${focusTag} (${visible.length}/${total})`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={props.focused ? "cyan" : "gray"}>{sectionLine(invTitle)}</Text>
      {total === 0 ? (
        <Text color="gray"> (no invocations yet)</Text>
      ) : (
        visible.map((r) => (
          <Box key={r.id}>
            <Text color="gray">{fmtTime(r.at)} </Text>
            <Text color={r.error ? "red" : "cyan"}>{r.toolName.padEnd(16, " ")}</Text>
            <Text color="gray"> {fmtDuration(r.durationMs).padStart(8, " ")}</Text>
            {r.error ? <Text color="red"> {r.error.slice(0, 40)}</Text> : null}
          </Box>
        ))
      )}
    </Box>
  );
}

// ─── Footer ─────────────────────────────────────────────────────────────────

export interface FooterProps {
  focusedPane: "graphs" | "invocations";
  lastRefreshAt: number;
}

export function Footer(props: FooterProps): ReactElement {
  return (
    <Box paddingX={1} flexDirection="column">
      <Text color="gray">
        {"[↑↓] select · [enter] expand · [tab] switch pane ("}
        {props.focusedPane}
        {") · [r] refresh · [p] pause · [q] quit"}
      </Text>
      <Text color="gray">last refresh: {fmtTime(new Date(props.lastRefreshAt).toISOString())}</Text>
    </Box>
  );
}
