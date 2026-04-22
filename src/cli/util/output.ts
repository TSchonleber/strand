/**
 * Shared output helpers — no deps, straight padded columns + JSON.
 *
 * Every subcommand that emits tabular data goes through `printTable`. Every
 * subcommand that supports `--json` goes through `printJson` for consistency.
 */

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function printLine(s = ""): void {
  process.stdout.write(`${s}\n`);
}

export function printErr(s: string): void {
  process.stderr.write(`${s}\n`);
}

export interface TableColumn<T> {
  header: string;
  value(row: T): string;
  /** Max display width, truncates with `…`. Default 60. */
  maxWidth?: number;
}

export function printTable<T>(rows: readonly T[], cols: readonly TableColumn<T>[]): void {
  if (rows.length === 0) {
    printLine("(no rows)");
    return;
  }
  const cells = rows.map((r) =>
    cols.map((c) => {
      const raw = c.value(r) ?? "";
      const max = c.maxWidth ?? 60;
      return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
    }),
  );
  const widths = cols.map((c, i) => {
    let w = c.header.length;
    for (const row of cells) {
      const cell = row[i] ?? "";
      if (cell.length > w) w = cell.length;
    }
    return w;
  });
  const fmt = (parts: readonly string[]): string =>
    parts.map((p, i) => p.padEnd(widths[i] ?? 0)).join("  ");
  printLine(fmt(cols.map((c) => c.header)));
  printLine(fmt(widths.map((w) => "─".repeat(w))));
  for (const row of cells) printLine(fmt(row));
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function mask(v: string): string {
  if (v.length <= 8) return "********";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
