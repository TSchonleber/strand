import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerDevCmd(program: Command, _ctx: CliContext): void {
  program
    .command("dev")
    .description("dev — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand dev: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
