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

// ─── ASCII bar helper ────────────────────────────────────────────────────────

function asciiBar(value: number, max: number, width = 10): string {
  if (max <= 0) return `[${"─".repeat(width)}]`;
  const ratio = Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"─".repeat(width - filled)}]`;
}

// ─── Cockpit banner ─────────────────────────────────────────────────────────

export function CockpitBanner(): ReactElement {
  return (
    <Box paddingX={1}>
      <Text bold color="magenta">
        Strand
      </Text>
      <Text color="gray"> — operator cockpit</Text>
    </Box>
  );
}

// ─── Mission panel ──────────────────────────────────────────────────────────

export interface MissionPanelProps {
  mode: string;
  halt: string;
  tier: string;
  provider: string;
  model: string;
}

export function MissionPanel(props: MissionPanelProps): ReactElement {
  const modeColor = props.mode === "live" ? "red" : props.mode === "gated" ? "yellow" : "green";
  const haltOn = props.halt === "true";
  return (
    <Box width={40} borderStyle="single" borderColor="cyan" flexDirection="column">
      <Text bold color="cyan">
        {" "}
        MISSION
      </Text>
      <Box>
        <Text color="gray"> MODE </Text>
        <Text bold color={modeColor}>
          {props.mode.padEnd(9)}
        </Text>
        <Text color="gray">HALT </Text>
        <Text bold color={haltOn ? "red" : "green"}>
          {haltOn ? "\u25CF ON" : "\u25CF off"}
        </Text>
      </Box>
      <Box>
        <Text color="gray"> TIER </Text>
        <Text color="white">{props.tier}</Text>
      </Box>
      <Box>
        <Text color="gray"> </Text>
        <Text color="white">
          {props.provider}/{props.model.slice(0, 28)}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Safety Shield panel ────────────────────────────────────────────────────

export interface SafetyShieldPanelProps {
  reviewQueued: number;
  reviewActive: number;
  dlqFailed: number;
  totalRuns: number;
  completedRuns: number;
}

export function SafetyShieldPanel(props: SafetyShieldPanelProps): ReactElement {
  const queueColor = props.reviewQueued > 0 ? "yellow" : "green";
  const dlqColor = props.dlqFailed > 0 ? "red" : "green";
  const healthMax = Math.max(props.totalRuns, 1);
  const healthBar = asciiBar(props.completedRuns, healthMax, 10);
  return (
    <Box width={40} borderStyle="single" borderColor="green" flexDirection="column">
      <Text bold color="green">
        {" "}
        SAFETY SHIELD
      </Text>
      <Box>
        <Text color="gray"> Review </Text>
        <Text color={queueColor}>{String(props.reviewQueued).padStart(3)} queued</Text>
        <Text color="cyan">
          {"  "}
          {String(props.reviewActive).padStart(2)} active
        </Text>
      </Box>
      <Box>
        <Text color="gray"> DLQ </Text>
        <Text color={dlqColor}>{String(props.dlqFailed).padStart(3)} failed</Text>
      </Box>
      <Box>
        <Text color="gray"> Health </Text>
        <Text color="green">{healthBar}</Text>
        <Text color="gray">
          {"  "}
          {props.totalRuns} runs
        </Text>
      </Box>
    </Box>
  );
}

// ─── Pulse panel ────────────────────────────────────────────────────────────

export interface PulsePanelProps {
  ticks: number;
  candidates: number;
  toolCalls: number;
  costUsdTicks: number;
}

export function PulsePanel(props: PulsePanelProps): ReactElement {
  const tickMax = Math.max(props.ticks, 100);
  const toolMax = Math.max(props.toolCalls, 50);
  return (
    <Box width={40} borderStyle="single" borderColor="yellow" flexDirection="column">
      <Text bold color="yellow">
        {" "}
        PULSE
      </Text>
      <Box>
        <Text color="gray"> Ticks </Text>
        <Text>{String(props.ticks).padStart(5)} ticks </Text>
        <Text color="cyan">{asciiBar(props.ticks, tickMax, 12)}</Text>
      </Box>
      <Box>
        <Text color="gray"> Cands </Text>
        <Text>{String(props.candidates).padStart(5)} candidates</Text>
      </Box>
      <Box>
        <Text color="gray"> Tools </Text>
        <Text>{String(props.toolCalls).padStart(5)} calls </Text>
        <Text color="cyan">{asciiBar(props.toolCalls, toolMax, 12)}</Text>
      </Box>
      <Box>
        <Text color="gray"> Cost </Text>
        <Text bold color="yellow">
          {fmtUsdFromTicks(props.costUsdTicks)}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Reach panel ────────────────────────────────────────────────────────────

export interface ReachPanelProps {
  followers?: number | null;
  delta24h?: number | null;
  xUsage?: string | null;
  xHealth?: string | null;
}

export function ReachPanel(props: ReachPanelProps): ReactElement {
  const val = (v: number | string | null | undefined, suffix = ""): string =>
    v != null ? `${v}${suffix}` : "\u2014";
  const healthColor =
    props.xHealth === "ok" ? "green" : props.xHealth === "degraded" ? "yellow" : "gray";
  return (
    <Box width={40} borderStyle="single" borderColor="magenta" flexDirection="column">
      <Text bold color="magenta">
        {" "}
        REACH
      </Text>
      <Box>
        <Text color="gray"> Followers </Text>
        <Text>{val(props.followers)}</Text>
      </Box>
      <Box>
        <Text color="gray"> 24h delta </Text>
        <Text
          color={
            props.delta24h != null && props.delta24h > 0
              ? "green"
              : props.delta24h != null && props.delta24h < 0
                ? "red"
                : "gray"
          }
        >
          {props.delta24h != null && props.delta24h > 0 ? "+" : ""}
          {val(props.delta24h)}
        </Text>
      </Box>
      <Box>
        <Text color="gray"> X usage </Text>
        <Text color="cyan">{val(props.xUsage)}</Text>
      </Box>
      <Box>
        <Text color="gray"> X health </Text>
        <Text color={healthColor}>{val(props.xHealth)}</Text>
      </Box>
    </Box>
  );
}

// ─── Header (legacy) ────────────────────────────────────────────────────────

export interface HeaderProps {
  provider: string;
  model: string;
  mode: string;
  credentialStore: string;
  tenant: string | null;
}

export function Header(props: HeaderProps): ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text bold color="magenta">
          Strand TUI
        </Text>
        <Text color="gray"> — live agent harness</Text>
      </Box>
      <Box>
        <Text color="gray">provider: </Text>
        <Text color="white">
          {props.provider}/{props.model}
        </Text>
        <Text color="gray"> mode: </Text>
        <Text color={props.mode === "live" ? "red" : props.mode === "gated" ? "yellow" : "green"}>
          {props.mode}
        </Text>
      </Box>
      <Box>
        <Text color="gray">credential store: </Text>
        <Text>{props.credentialStore}</Text>
        <Text color="gray"> tenant: </Text>
        <Text>{props.tenant ?? "\u2014"}</Text>
      </Box>
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
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={props.focused ? "cyan" : "gray"}>
        {"─── active task graphs "}
        {props.focused ? "[focused]" : ""}
      </Text>
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
      <Text color="gray">{"─── recent runs (24h)"}</Text>
      <Box>
        <Text color="gray">reasoner: </Text>
        <Text>{r.ticks} ticks · </Text>
        <Text>{r.candidates} candidates · </Text>
        <Text>{r.toolCalls} tool calls · </Text>
        <Text color="yellow">{fmtUsdFromTicks(r.costUsdTicks)}</Text>
      </Box>
      <Box>
        <Text color="gray">consolidator: </Text>
        <Text>{c.total} runs · </Text>
        <Text color="green">{c.completed} completed</Text>
        <Text> · </Text>
        <Text color="red">{c.failed} failed</Text>
        <Text> · </Text>
        <Text color="cyan">{c.inProgress} in-progress</Text>
        <Text> · </Text>
        <Text color="gray">{c.queued} queued</Text>
      </Box>
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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={props.focused ? "cyan" : "gray"}>
        {"─── tool invocations "}
        {props.focused ? "[focused] " : ""}
        (showing {visible.length}/{total})
      </Text>
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
