import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerConfigCmd(program: Command, _ctx: CliContext): void {
  program
    .command("config")
    .description("config — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand config: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
