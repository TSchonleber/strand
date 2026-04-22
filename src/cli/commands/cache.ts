import type { Command } from "commander";
import type { CliContext } from "../index";
import { printLine, printTable } from "../util/output";

/**
 * `strand cache` — surface prompt-cache hit rates from recent reasoner runs.
 *
 * Reads `reasoner_runs.usage_json` for the last N days, aggregates:
 *   - total input tokens
 *   - cached input tokens
 *   - cache ratio = cached / input
 *   - estimated $ saved vs no cache (at a conservative 10× discount on cached)
 *
 * Any ratio below ~0.3 on the 2nd+ day usually means prefix churn. Run this
 * weekly to catch regressions early.
 */

interface UsageRow {
  tick_at: string;
  usage_json: string | null;
  cost_in_usd_ticks: number | null;
}

interface UsageTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  costTicks: number;
  rows: number;
}

function emptyTotals(): UsageTotals {
  return { input: 0, cached: 0, output: 0, reasoning: 0, costTicks: 0, rows: 0 };
}

function formatTicks(ticks: number): string {
  const usd = ticks / 1e10;
  return `$${usd.toFixed(4)}`;
}

function formatPct(num: number, den: number): string {
  if (den === 0) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

export function registerCacheCmd(program: Command, _ctx: CliContext): void {
  program
    .command("cache")
    .description("prompt-cache hit rates from recent reasoner runs")
    .option("-d, --days <n>", "look-back window in days", "7")
    .option("--json", "emit raw JSON")
    .action(async (opts: { days: string; json?: boolean }) => {
      const days = Math.max(1, Number(opts.days) || 7);
      const { db } = await import("@/db");

      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const rows = db()
        .prepare(
          "SELECT tick_at, usage_json, cost_in_usd_ticks FROM reasoner_runs WHERE tick_at >= ? ORDER BY tick_at ASC",
        )
        .all(cutoff) as UsageRow[];

      const total = emptyTotals();
      const perDay = new Map<string, UsageTotals>();

      for (const row of rows) {
        if (!row.usage_json) continue;
        let usage: {
          inputTokens?: number;
          cachedInputTokens?: number;
          outputTokens?: number;
          reasoningTokens?: number;
        } | null = null;
        try {
          usage = JSON.parse(row.usage_json);
        } catch {
          continue;
        }
        const input = usage?.inputTokens ?? 0;
        const cached = usage?.cachedInputTokens ?? 0;
        const output = usage?.outputTokens ?? 0;
        const reasoning = usage?.reasoningTokens ?? 0;
        const costTicks = row.cost_in_usd_ticks ?? 0;

        total.input += input;
        total.cached += cached;
        total.output += output;
        total.reasoning += reasoning;
        total.costTicks += costTicks;
        total.rows += 1;

        const day = row.tick_at.slice(0, 10);
        const bucket = perDay.get(day) ?? emptyTotals();
        bucket.input += input;
        bucket.cached += cached;
        bucket.output += output;
        bucket.reasoning += reasoning;
        bucket.costTicks += costTicks;
        bucket.rows += 1;
        perDay.set(day, bucket);
      }

      if (opts.json) {
        const payload = {
          window_days: days,
          total,
          by_day: Object.fromEntries(perDay),
        };
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }

      if (total.rows === 0) {
        printLine(`no reasoner_runs in the last ${days} day(s) — run some ticks first`);
        return;
      }

      // Summary line
      printLine("");
      printLine(`prompt cache — last ${days} day(s)`);
      printLine("─".repeat(48));
      printLine(`reasoner ticks:   ${total.rows}`);
      printLine(
        `input tokens:     ${total.input.toLocaleString()}  (${total.cached.toLocaleString()} cached, ${formatPct(
          total.cached,
          total.input,
        )})`,
      );
      printLine(`output tokens:    ${total.output.toLocaleString()}`);
      if (total.reasoning > 0) {
        printLine(`reasoning tokens: ${total.reasoning.toLocaleString()}`);
      }
      printLine(`cost (meter):     ${formatTicks(total.costTicks)}`);

      // Rough savings estimate: providers typically charge ~10% on cached
      // input tokens. So savings ≈ cached × 0.9 × effective input rate.
      // We don't know the rate here without the per-row model; show the
      // token-level saving which is what operators can audit.
      const wouldHaveBeen = total.input; // if no cache, every input token paid full
      const actuallyBilledApprox = total.input - total.cached * 0.9; // 90% discount on cached
      const tokenSavings = Math.max(0, wouldHaveBeen - actuallyBilledApprox);
      printLine(
        `est. token savings vs no-cache: ${Math.round(tokenSavings).toLocaleString()} input-tokens @ 90% discount`,
      );

      // Per-day table
      if (perDay.size > 1) {
        printLine("");
        printLine("by day:");
        const dayRows = [...perDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, t]) => ({ day, t }));
        printTable(dayRows, [
          { header: "date", value: (r) => r.day },
          { header: "ticks", value: (r) => String(r.t.rows) },
          { header: "input", value: (r) => r.t.input.toLocaleString() },
          { header: "cached", value: (r) => r.t.cached.toLocaleString() },
          { header: "ratio", value: (r) => formatPct(r.t.cached, r.t.input) },
          { header: "cost", value: (r) => formatTicks(r.t.costTicks) },
        ]);
      }

      // Operator advice
      printLine("");
      if (total.input > 0 && total.cached / total.input < 0.3 && total.rows >= 5) {
        printLine("⚠ cache ratio below 30% over 5+ ticks — prefix drift likely.");
        printLine("  Check: tool catalog order, dynamic content in system prompts,");
        printLine("  promptCacheKey stability across loops + spawned children.");
      } else if (total.input > 0 && total.cached / total.input > 0.5) {
        printLine("✓ cache ratio healthy (> 50%)");
      }
    });
}
