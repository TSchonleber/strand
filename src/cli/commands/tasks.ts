import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerTasksCmd(program: Command, _ctx: CliContext): void {
  program
    .command("tasks")
    .description("tasks — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand tasks: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
