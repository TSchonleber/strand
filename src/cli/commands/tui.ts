import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerTuiCmd(program: Command, _ctx: CliContext): void {
  program
    .command("tui")
    .description("tui — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand tui: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
