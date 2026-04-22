import type { Command } from "commander";
import type { CliContext } from "../index";
import { launchTui } from "../tui/index";

export function registerTuiCmd(program: Command, _ctx: CliContext): void {
  program
    .command("tui")
    .description("welcome splash with commands + tools; --dashboard for live view")
    .option("-d, --dashboard", "start on the live dashboard instead of welcome")
    .option("--poll-ms <n>", "dashboard poll cadence in ms", "2000")
    .action(async (opts: { dashboard?: boolean; pollMs: string }) => {
      const n = Number(opts.pollMs);
      await launchTui({
        dashboard: opts.dashboard ?? false,
        pollMs: Number.isFinite(n) && n > 0 ? n : 2000,
      });
    });
}
