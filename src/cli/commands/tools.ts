import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerToolsCmd(program: Command, _ctx: CliContext): void {
  program
    .command("tools")
    .description("tools — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand tools: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
