import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerSmokeCmd(program: Command, _ctx: CliContext): void {
  program
    .command("smoke")
    .description("smoke — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand smoke: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
