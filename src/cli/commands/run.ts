import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerRunCmd(program: Command, _ctx: CliContext): void {
  program
    .command("run")
    .description("run — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand run: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
