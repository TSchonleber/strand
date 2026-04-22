import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerKeysCmd(program: Command, _ctx: CliContext): void {
  program
    .command("keys")
    .description("keys — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand keys: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
