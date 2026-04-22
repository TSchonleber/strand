import type { Command } from "commander";
import type { CliContext } from "../index";
import { printLine } from "../util/output";
import { getResolvedConfig } from "../util/resolved-config";

/**
 * Budget summary.
 *
 * Phase 2.1 note: Strand has no runtime singleton budget — budgets are
 * per-run objects. This command prints config defaults + env overrides +
 * historic cost from the last 24h of reasoner_runs + consolidator_runs.
 */
export function registerBudgetCmd(program: Command, _ctx: CliContext): void {
  program
    .command("budget")
    .description("summarize configured + observed spend (last 24h)")
    .action(async (_opts: unknown, cmd: Command) => {
      const cfg = getResolvedConfig(cmd).config;
      const { db } = await import("@/db");
      const dbh = db();

      printLine("=== configured budget defaults ===");
      const d = cfg.budget.defaults;
      printLine(`  tokens       ${d.tokens ?? "(unlimited)"}`);
      printLine(`  usdTicks     ${d.usdTicks ?? "(unlimited)"}`);
      printLine(`  wallClockMs  ${d.wallClockMs ?? "(unlimited)"}`);
      printLine(`  toolCalls    ${d.toolCalls ?? "(unlimited)"}`);
      printLine("");

      printLine("=== env overrides ===");
      for (const k of ["STRAND_MODE", "LLM_PROVIDER", "STRAND_CREDENTIAL_STORE"]) {
        printLine(`  ${k.padEnd(26)} ${process.env[k] ?? "(unset)"}`);
      }
      printLine("");

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const reasoner = dbh
        .prepare(
          "SELECT COUNT(*) as n, COALESCE(SUM(cost_in_usd_ticks),0) as total FROM reasoner_runs WHERE tick_at >= ?",
        )
        .get(since) as { n: number; total: number };
      printLine("=== last 24h reasoner_runs ===");
      printLine(`  runs         ${reasoner.n}`);
      printLine(`  cost ticks   ${reasoner.total}`);
      printLine(`  cost USD     $${(reasoner.total / 1e10).toFixed(4)}`);
      printLine("");

      const consolidator = dbh
        .prepare("SELECT status, summary_json FROM consolidator_runs WHERE created_at >= ?")
        .all(since) as Array<{ status: string; summary_json: string | null }>;
      let consTicks = 0;
      for (const c of consolidator) {
        if (!c.summary_json) continue;
        try {
          const parsed = JSON.parse(c.summary_json) as { cost_in_usd_ticks?: number };
          if (typeof parsed.cost_in_usd_ticks === "number") consTicks += parsed.cost_in_usd_ticks;
        } catch {
          /* ignore */
        }
      }
      printLine("=== last 24h consolidator_runs ===");
      printLine(`  runs         ${consolidator.length}`);
      printLine(`  cost ticks   ${consTicks}`);
      printLine(`  cost USD     $${(consTicks / 1e10).toFixed(4)}`);
    });
}
