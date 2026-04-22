import type { Command } from "commander";
import type { CliContext } from "../index";

export function registerOauthCmd(program: Command, _ctx: CliContext): void {
  program
    .command("oauth")
    .description("oauth — not yet wired (Pass N)")
    .action(() => {
      process.stderr.write("strand oauth: not yet wired (Pass N)\n");
      process.exit(2);
    });
}
