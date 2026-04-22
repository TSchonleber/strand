import type { Command } from "commander";
import type { CliContext } from "../index";
import { printLine } from "../util/output";

/**
 * Boot the orchestrator in-process. Replaces `pnpm dev`.
 *
 * Direct-import path — no subprocess. `registerShutdown()` installs SIGINT
 * handlers that call `stop()` and exit cleanly. We hold the process open
 * with an unresolved promise; SIGINT terminates via the shutdown handler.
 */
export function registerDevCmd(program: Command, _ctx: CliContext): void {
  program
    .command("dev")
    .description("boot the strand orchestrator in-process (Ctrl-C to stop)")
    .action(async () => {
      const orchestrator = await import("@/orchestrator");
      orchestrator.registerShutdown();
      orchestrator.start();
      printLine("strand dev: orchestrator started (Ctrl-C to stop)");
      await new Promise<never>(() => {
        /* held open by SIGINT handler in registerShutdown */
      });
    });
}
