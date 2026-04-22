import type { Command } from "commander";
import YAML from "yaml";
import { loadConfig } from "../config";
import type { CliContext } from "../index";
import { printLine } from "../util/output";
import { getResolvedConfig } from "../util/resolved-config";

export function registerConfigCmd(program: Command, _ctx: CliContext): void {
  const cfg = program.command("config").description("inspect + validate strand config");

  cfg
    .command("show")
    .description("print the loaded config as YAML")
    .option("--resolve", "additionally print env overrides that would apply")
    .action((opts: { resolve?: boolean }, cmd: Command) => {
      const resolved = getResolvedConfig(cmd);
      printLine(`# source: ${resolved.source}${resolved.path ? ` (${resolved.path})` : ""}`);
      process.stdout.write(YAML.stringify(resolved.config));
      if (opts.resolve) {
        printLine("");
        printLine("# env overrides (set iff absent):");
        const pairs = envOverrides(resolved.config);
        for (const [k, v] of pairs) {
          const cur = process.env[k];
          const applied = cur === undefined || cur === "";
          printLine(`#   ${k}=${v}    ${applied ? "(applied)" : "(env wins)"}`);
        }
      }
    });

  cfg
    .command("validate")
    .description("parse a config file and report errors")
    .option("--file <path>", "config file to validate")
    .action((opts: { file?: string }) => {
      try {
        const resolved = loadConfig(
          opts.file ? { path: opts.file, silent: true } : { silent: true },
        );
        printLine(`ok: ${resolved.source}${resolved.path ? ` ${resolved.path}` : ""}`);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}

function envOverrides(cfg: {
  mode: string;
  llm: { provider: string; model: { reasoner: string; composer: string; judge: string } };
  credentials: { store: string; tenant: string | null };
  x: { tier: string; oauthRedirect: string };
  brainctl: { command: string; args: string; remoteMcpUrl: string | null };
}): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ["STRAND_MODE", cfg.mode],
    ["LLM_PROVIDER", cfg.llm.provider],
    ["LLM_MODEL_REASONER", cfg.llm.model.reasoner],
    ["LLM_MODEL_COMPOSER", cfg.llm.model.composer],
    ["LLM_MODEL_JUDGE", cfg.llm.model.judge],
    ["STRAND_CREDENTIAL_STORE", cfg.credentials.store],
    ["TIER", cfg.x.tier],
    ["X_OAUTH_REDIRECT_URI", cfg.x.oauthRedirect],
    ["BRAINCTL_COMMAND", cfg.brainctl.command],
    ["BRAINCTL_ARGS", cfg.brainctl.args],
  ];
  if (cfg.credentials.tenant) pairs.push(["STRAND_TENANT", cfg.credentials.tenant]);
  if (cfg.brainctl.remoteMcpUrl) pairs.push(["BRAINCTL_REMOTE_MCP_URL", cfg.brainctl.remoteMcpUrl]);
  return pairs;
}
