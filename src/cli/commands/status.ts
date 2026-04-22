import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerStatusCmd(program: Command, _ctx: CliContext): void {
  program
    .command("status")
    .description("status — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand status: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
