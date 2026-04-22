import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerBudgetCmd(program: Command, _ctx: CliContext): void {
  program
    .command("budget")
    .description("budget — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand budget: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
