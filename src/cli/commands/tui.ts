import type { Command } from "commander";
import type { CliContext } from "../index";
import { launchTui } from "../tui/index";

export function registerTuiCmd(program: Command, _ctx: CliContext): void {
  program
    .command("tui")
    .description("launch live Strand TUI (agent tree + trace + budget)")
    .option("--poll-ms <n>", "override default poll cadence", "2000")
    .action(async (opts: { pollMs: string }) => {
      const n = Number(opts.pollMs);
      await launchTui({ pollMs: Number.isFinite(n) && n > 0 ? n : 2000 });
    });
}
