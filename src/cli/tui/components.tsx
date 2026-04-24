/**
 * Stateless presentational components for the Strand TUI.
 *
 * Every visible row is sized before Ink sees it. That keeps the cockpit stable
 * in 80-column terminals and avoids flex-row wrapping between adjacent Text
 * nodes.
 */

import type { PlanStep, StepStatus, TaskGraph } from "@/agent/types";
import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import type { InvocationRow, OperatorSnapshot, RunSummary } from "./hooks";
import { fit, kv, pad, panelInnerWidth, ratioBar, sign, truncate } from "./layout";

// --- Visual helpers ---------------------------------------------------------

function statusGlyph(s: StepStatus): string {
  switch (s) {
    case "completed":
      return "ok";
    case "running":
      return ">>";
    case "failed":
      return "!!";
    case "skipped":
      return "--";
    case "abandoned":
      return "xx";
    case "pending":
      return "..";
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
  return id.length > 6 ? `${id.slice(0, 6)}...` : id;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso.slice(11, 19) || iso;
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso.slice(11, 19) || iso;
  }
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsdFromTicks(ticks: number): string {
  const usd = ticks / 1e10;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtMinutes(minutes: number | null): string {
  if (minutes == null) return "-";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  return `${Math.floor(hours / 24)}d`;
}

function fmtMaybeCount(n: number | null): string {
  return n == null ? "-" : String(n);
}

function fmtNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function panelColor(issueCount: number): string {
  if (issueCount > 0) return "red";
  return "green";
}

function Panel({
  title,
  width,
  color = "gray",
  children,
}: {
  title: string;
  width: number;
  color?: string;
  children: ReactNode;
}): ReactElement {
  const inner = panelInnerWidth(width);
  return (
    <Box width={width} flexDirection="column" borderStyle="single" borderColor={color} paddingX={1}>
      <Text bold color={color}>
        {fit(title, inner)}
      </Text>
      {children}
    </Box>
  );
}

function PanelLine({
  width,
  color,
  children,
}: {
  width: number;
  color?: string;
  children: string;
}): ReactElement {
  const line = fit(children, panelInnerWidth(width));
  if (color) return <Text color={color}>{line}</Text>;
  return <Text>{line}</Text>;
}

// --- Header ----------------------------------------------------------------

export interface HeaderProps {
  provider: string;
  model: string;
  mode: string;
  halt: string;
  tier: string;
  credentialStore: string;
  tenant: string | null;
  width?: number;
}

export function Header(props: HeaderProps): ReactElement {
  const width = props.width ?? 80;
  const inner = Math.max(20, width - 2);
  const modelBudget = Math.max(14, inner - 42);
  const model = truncate(`${props.provider}/${props.model}`, modelBudget);
  const halt = props.halt === "true" ? "HALTED" : "armed";
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="magenta">
        {fit("STRAND COCKPIT - live agent harness", inner)}
      </Text>
      <Text color="gray">
        {fit(`model ${model} | mode ${props.mode} | halt ${halt} | tier ${props.tier}`, inner)}
      </Text>
      <Text color="gray">
        {fit(`credential store ${props.credentialStore} | tenant ${props.tenant ?? "-"}`, inner)}
      </Text>
    </Box>
  );
}

// --- Operator cockpit -------------------------------------------------------

export interface OperatorPaneProps {
  snapshot: OperatorSnapshot;
  loading: boolean;
  width: number;
}

function healthColor(row: OperatorSnapshot["x"]["latestHealth"][number]): string {
  if (row.healthy === 0) return "red";
  if (row.remaining != null && row.limit != null && row.limit > 0) {
    const ratio = row.remaining / row.limit;
    if (ratio < 0.1) return "red";
    if (ratio < 0.25) return "yellow";
  }
  return "green";
}

function healthText(row: OperatorSnapshot["x"]["latestHealth"][number]): string {
  const state = healthColor(row) === "green" ? "ok" : healthColor(row);
  return `${row.endpoint} ${fmtMaybeCount(row.remaining)}/${fmtMaybeCount(row.limit)} ${state}`;
}

function actionsByKindText(rows: OperatorSnapshot["actions24h"]["byKind"]): string {
  if (rows.length === 0) return "none";
  return rows.map((r) => `${r.kind}:${r.count}`).join(" ");
}

export function OperatorPane({ snapshot, loading, width }: OperatorPaneProps): ReactElement {
  const inner = panelInnerWidth(width);
  const barWidth = Math.max(8, Math.min(18, Math.floor(inner / 5)));
  const actionTotal = Math.max(1, snapshot.actions24h.total);
  const executedBar = ratioBar(snapshot.actions24h.executed, actionTotal, barWidth);
  const guardIssueCount =
    snapshot.guardrails.dlqOpen + snapshot.actions24h.failed + snapshot.actions24h.rejected;
  const usageBar =
    snapshot.x.monthlyUsed == null || snapshot.x.monthlyCap == null
      ? "[-]"
      : ratioBar(snapshot.x.monthlyUsed, snapshot.x.monthlyCap, barWidth);
  const monthly =
    snapshot.x.monthlyUsed == null || snapshot.x.monthlyCap == null
      ? "-"
      : `${snapshot.x.monthlyUsed}/${snapshot.x.monthlyCap}`;
  const followers = snapshot.followers
    ? `${fmtNumber(snapshot.followers.count)} (${sign(snapshot.followers.delta24h)} 24h)`
    : "-";
  const latestHealth = snapshot.x.latestHealth.slice(0, 3).map(healthText).join(" | ");
  const title = loading ? "operator cockpit / syncing" : "operator cockpit";

  return (
    <Panel title={title} width={width} color={panelColor(guardIssueCount)}>
      <PanelLine width={width} color={snapshot.review.open > 0 ? "yellow" : "green"}>
        {`MISSION ${kv("review", snapshot.review.open)} open | oldest ${fmtMinutes(
          snapshot.review.oldestMinutes,
        )} | actions ${snapshot.actions24h.total}`}
      </PanelLine>
      <PanelLine width={width} color={snapshot.actions24h.failed > 0 ? "red" : "cyan"}>
        {`PULSE   exec ${executedBar} ${snapshot.actions24h.executed}/${snapshot.actions24h.total} | approved ${snapshot.actions24h.approved} | kinds ${actionsByKindText(
          snapshot.actions24h.byKind,
        )}`}
      </PanelLine>
      <PanelLine width={width} color={panelColor(guardIssueCount)}>
        {`SHIELD  cooldowns ${snapshot.guardrails.activeCooldowns} | dlq ${snapshot.guardrails.dlqOpen} | dedup ${snapshot.guardrails.recentDuplicateHashes} | rejected ${snapshot.actions24h.rejected} | failed ${snapshot.actions24h.failed}`}
      </PanelLine>
      <PanelLine width={width} color="magenta">
        {`REACH   x usage ${usageBar} ${monthly} | followers ${followers}`}
      </PanelLine>
      <PanelLine width={width} color={latestHealth.length === 0 ? "gray" : "green"}>
        {`HEALTH  ${latestHealth.length === 0 ? "no snapshots" : latestHealth}`}
      </PanelLine>
    </Panel>
  );
}

// --- Task graphs ------------------------------------------------------------

export interface TaskGraphsPaneProps {
  graphs: TaskGraph[];
  loading: boolean;
  selectedIdx: number;
  expanded: boolean;
  focused: boolean;
  width: number;
}

function stepLine(step: PlanStep, width: number): string {
  const duration =
    step.startedAt && step.completedAt
      ? fmtDuration(new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime())
      : step.startedAt
        ? fmtDuration(Date.now() - new Date(step.startedAt).getTime())
        : "-";
  const prefix = `${statusGlyph(step.status)} ${pad(step.status, 9)} ${duration.padStart(8)} `;
  const suffix = step.error ? ` | error ${step.error}` : "";
  return `${prefix}${truncate(step.goal, Math.max(12, width - prefix.length - suffix.length))}${suffix}`;
}

function graphLine(g: TaskGraph, selected: boolean, width: number): string {
  const total = g.steps.length;
  const done = g.steps.filter((s) => s.status === "completed").length;
  const running = g.steps.some((s) => s.status === "running");
  const cursor = selected ? ">" : " ";
  const prefix = `${cursor} ${shortId(g.id)} ${pad(g.status, 10)} `;
  const suffix = ` ${done}/${total} steps${running ? " running" : ""}`;
  return `${prefix}${truncate(g.rootGoal, Math.max(10, width - prefix.length - suffix.length))}${suffix}`;
}

export function TaskGraphsPane(props: TaskGraphsPaneProps): ReactElement {
  const inner = panelInnerWidth(props.width);
  const title = `active task graphs${props.focused ? " / focused" : ""}`;
  return (
    <Panel title={title} width={props.width} color={props.focused ? "cyan" : "gray"}>
      {props.loading && props.graphs.length === 0 ? (
        <PanelLine width={props.width} color="gray">
          {"loading active graphs"}
        </PanelLine>
      ) : props.graphs.length === 0 ? (
        <PanelLine width={props.width} color="gray">
          {"(no active graphs)"}
        </PanelLine>
      ) : (
        props.graphs.map((g, i) => (
          <Box key={g.id} flexDirection="column">
            <PanelLine
              width={props.width}
              color={i === props.selectedIdx ? "cyan" : statusColor(g.status)}
            >
              {graphLine(g, i === props.selectedIdx, inner)}
            </PanelLine>
            {props.expanded && i === props.selectedIdx
              ? g.steps.map((s) => (
                  <PanelLine key={s.id} width={props.width} color={statusColor(s.status)}>
                    {stepLine(s, inner)}
                  </PanelLine>
                ))
              : null}
          </Box>
        ))
      )}
    </Panel>
  );
}

// --- Run summary ------------------------------------------------------------

export interface RunSummaryPaneProps {
  summary: RunSummary;
  loading: boolean;
  width: number;
}

export function RunSummaryPane(props: RunSummaryPaneProps): ReactElement {
  const r = props.summary.reasoner;
  const c = props.summary.consolidator;
  const inner = panelInnerWidth(props.width);
  const barWidth = Math.max(8, Math.min(18, Math.floor(inner / 5)));
  const title = props.loading ? "run pulse 24h / syncing" : "run pulse 24h";
  return (
    <Panel title={title} width={props.width} color={c.failed > 0 ? "yellow" : "green"}>
      <PanelLine width={props.width} color="cyan">
        {`reasoner ${r.ticks} ticks | ${r.candidates} candidates | ${r.toolCalls} tool calls | ${fmtUsdFromTicks(
          r.costUsdTicks,
        )}`}
      </PanelLine>
      <PanelLine width={props.width} color={c.failed > 0 ? "yellow" : "green"}>
        {`consolidator ${ratioBar(c.completed, Math.max(1, c.total), barWidth)} ${c.total} runs | ok ${c.completed} | fail ${c.failed} | wip ${c.inProgress} | queue ${c.queued}`}
      </PanelLine>
    </Panel>
  );
}

// --- Invocations ------------------------------------------------------------

export interface InvocationsPaneProps {
  rows: InvocationRow[];
  loading: boolean;
  focused: boolean;
  scrollOffset: number;
  maxRows?: number;
  width: number;
}

export function InvocationsPane(props: InvocationsPaneProps): ReactElement {
  const maxRows = props.maxRows ?? 8;
  const total = props.rows.length;
  const start = Math.min(Math.max(0, props.scrollOffset), Math.max(0, total - 1));
  const visible = props.rows.slice(start, start + maxRows);
  const inner = panelInnerWidth(props.width);
  const title = `tool invocations${props.focused ? " / focused" : ""} (${visible.length}/${total})`;

  return (
    <Panel title={title} width={props.width} color={props.focused ? "cyan" : "gray"}>
      {total === 0 ? (
        <PanelLine width={props.width} color="gray">
          {"(no invocations yet)"}
        </PanelLine>
      ) : (
        visible.map((r) => {
          const prefix = `${fmtTime(r.at)} ${pad(truncate(r.toolName, 18), 18)} ${pad(
            fmtDuration(r.durationMs),
            8,
          )}`;
          const error = r.error ? ` error ${r.error}` : "";
          return (
            <PanelLine key={r.id} width={props.width} color={r.error ? "red" : "cyan"}>
              {fit(`${prefix}${truncate(error, Math.max(0, inner - prefix.length))}`, inner)}
            </PanelLine>
          );
        })
      )}
    </Panel>
  );
}

// --- Help + footer ----------------------------------------------------------

export interface HelpEntry {
  key: string;
  description: string;
}

export const HELP_ENTRIES: HelpEntry[] = [
  { key: "?", description: "toggle this help menu" },
  { key: "tab", description: "switch focus between graphs and tools" },
  { key: "up/down", description: "move graph selection or invocation scroll" },
  { key: "enter", description: "expand or collapse the selected graph" },
  { key: "r", description: "refresh every data panel once" },
  { key: "p", description: "pause or resume polling" },
  { key: "w", description: "return to the welcome screen" },
  { key: "q / ctrl-c", description: "quit Strand cockpit" },
  { key: "esc", description: "close help" },
];

export interface HelpPanelProps {
  width: number;
  focusedPane: "graphs" | "invocations";
  paused: boolean;
}

export function HelpPanel(props: HelpPanelProps): ReactElement {
  return (
    <Panel title="help / cockpit controls" width={props.width} color="yellow">
      <PanelLine width={props.width} color="gray">
        {`state focus ${props.focusedPane} | polling ${props.paused ? "paused" : "live"}`}
      </PanelLine>
      {HELP_ENTRIES.map((entry) => (
        <PanelLine key={entry.key} width={props.width}>
          {`${pad(`[${entry.key}]`, 12)} ${entry.description}`}
        </PanelLine>
      ))}
    </Panel>
  );
}

export interface FooterProps {
  focusedPane: "graphs" | "invocations";
  lastRefreshAt: number;
  paused: boolean;
  width: number;
}

export function Footer(props: FooterProps): ReactElement {
  const inner = Math.max(20, props.width - 2);
  const verb = props.paused ? "resume" : "pause";
  const focusHint =
    props.focusedPane === "graphs" ? "[up/down] select  [enter] expand" : "[up/down] scroll tools";
  return (
    <Box paddingX={1} flexDirection="column">
      <Text color="gray">
        {fit(
          `[?] help  [tab] focus ${props.focusedPane}  [r] refresh  [p] ${verb}  [q] quit`,
          inner,
        )}
      </Text>
      <Text color="gray">
        {fit(
          `${focusHint}  [w] welcome  refreshed ${fmtTime(new Date(props.lastRefreshAt).toISOString())}`,
          inner,
        )}
      </Text>
    </Box>
  );
}
