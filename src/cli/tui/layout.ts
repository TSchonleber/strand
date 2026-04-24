/**
 * Width-safe text helpers for Ink layouts.
 *
 * Ink wraps long text aggressively when adjacent Text nodes sit in flex rows.
 * The cockpit uses pre-sized strings so every visible line fits the reported
 * terminal width.
 */

export const DEFAULT_TERMINAL_WIDTH = 80;
export const MIN_TERMINAL_WIDTH = 60;
export const MAX_TERMINAL_WIDTH = 160;
export const PANEL_PADDING_X = 1;

export function terminalWidth(columns: number | undefined | null): number {
  if (columns == null || !Number.isFinite(columns)) return DEFAULT_TERMINAL_WIDTH;
  return Math.max(MIN_TERMINAL_WIDTH, Math.min(MAX_TERMINAL_WIDTH, Math.floor(columns)));
}

export function panelInnerWidth(width: number, paddingX = PANEL_PADDING_X): number {
  return Math.max(12, width - 2 - paddingX * 2);
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${value.slice(0, width - 3)}...`;
}

export function pad(value: string, width: number): string {
  const short = truncate(value, width);
  if (short.length >= width) return short;
  return short + " ".repeat(width - short.length);
}

export function fit(value: string, width: number): string {
  return pad(value, width);
}

export function kv(label: string, value: string | number | null | undefined): string {
  return `${label} ${value ?? "-"}`;
}

export function sign(value: number | null | undefined): string {
  if (value == null) return "-";
  if (value > 0) return `+${value}`;
  return String(value);
}

export function ratioBar(value: number, max: number, width: number): string {
  const safeWidth = Math.max(3, width);
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const filled = Math.round(ratio * safeWidth);
  return `[${"#".repeat(filled)}${"-".repeat(safeWidth - filled)}]`;
}

export function splitWidths(totalWidth: number):
  | { stacked: true; full: number }
  | {
      stacked: false;
      left: number;
      right: number;
      gap: number;
    } {
  if (totalWidth < 112) return { stacked: true, full: totalWidth };
  const gap = 1;
  const left = Math.floor((totalWidth - gap) * 0.58);
  const right = totalWidth - gap - left;
  return { stacked: false, left, right, gap };
}
