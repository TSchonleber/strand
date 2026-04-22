#!/usr/bin/env node
/**
 * `strand` — unified CLI entry for the agent harness.
 *
 * Every subcommand gets the resolved config automatically. Global flags:
 *   --config <path>   override config discovery (cwd → ~/.strand → defaults)
 *   --log-level <lvl> trace | debug | info | warn | error | fatal
 */

import { Command } from "commander";
import { registerBudgetCmd } from "./commands/budget";
import { registerCacheCmd } from "./commands/cache";
import { registerConfigCmd } from "./commands/config";
import { registerDevCmd } from "./commands/dev";
import { registerKeysCmd } from "./commands/keys";
import { registerOauthCmd } from "./commands/oauth";
import { registerReviewCmd } from "./commands/review";
import { registerRunCmd } from "./commands/run";
import { registerSkillsCmd } from "./commands/skills";
import { registerSmokeCmd } from "./commands/smoke";
import { registerStatusCmd } from "./commands/status";
import { registerTasksCmd } from "./commands/tasks";
import { registerToolsCmd } from "./commands/tools";
import { registerTuiCmd } from "./commands/tui";
import { applyConfigToEnv, loadConfig } from "./config";

export interface CliContext {
  configPath?: string;
}

async function main(): Promise<number> {
  const program = new Command();
  program
    .name("strand")
    .description("Strand — agent harness CLI")
    .version("0.1.0")
    .option("-c, --config <path>", "path to strand.config.yaml (overrides discovery)")
    .option("--log-level <level>", "log level", "info")
    .hook("preAction", (thisCmd) => {
      const opts = thisCmd.optsWithGlobals<{ config?: string; logLevel?: string }>();
      if (opts.logLevel) {
        Object.assign(process.env, { LOG_LEVEL: opts.logLevel });
      }
      const resolved = loadConfig(opts.config ? { path: opts.config } : {});
      applyConfigToEnv(resolved.config);
      // Stash for child commands that want the raw config:
      (thisCmd as unknown as { _resolvedConfig: typeof resolved })._resolvedConfig = resolved;
    });

  const ctx: CliContext = {};
  registerRunCmd(program, ctx);
  registerTuiCmd(program, ctx);
  registerStatusCmd(program, ctx);
  registerReviewCmd(program, ctx);
  registerTasksCmd(program, ctx);
  registerBudgetCmd(program, ctx);
  registerCacheCmd(program, ctx);
  registerToolsCmd(program, ctx);
  registerSkillsCmd(program, ctx);
  registerKeysCmd(program, ctx);
  registerOauthCmd(program, ctx);
  registerConfigCmd(program, ctx);
  registerDevCmd(program, ctx);
  registerSmokeCmd(program, ctx);

  await program.parseAsync(process.argv);
  return 0;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`strand: ${msg}\n`);
  process.exit(1);
});
