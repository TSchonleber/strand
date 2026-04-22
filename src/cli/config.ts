import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { log } from "@/util/log";
import YAML from "yaml";
import { z } from "zod";

/**
 * Strand CLI config.
 *
 * Resolution order:
 *   1. Explicit `--config <path>` flag (highest priority)
 *   2. `./strand.config.yaml` in CWD
 *   3. `~/.strand/config.yaml`
 *   4. Built-in defaults (all fields optional).
 *
 * The loaded config merges on top of `process.env` — env still wins when both
 * are set, because operators override deploy-wide config with per-run env.
 * To force config-wins, use `--config` with a precomputed merged file.
 */

const BudgetDefaultsSchema = z
  .object({
    tokens: z.number().int().positive().optional(),
    usdTicks: z.number().int().nonnegative().optional(),
    wallClockMs: z.number().int().positive().optional(),
    toolCalls: z.number().int().positive().optional(),
  })
  .default({});

const AgentConfigSchema = z
  .object({
    maxDepth: z.number().int().min(1).max(10).default(3),
    maxSteps: z.number().int().min(1).max(20).default(5),
    maxIterationsPerStep: z.number().int().min(1).max(20).default(4),
    contextEngine: z
      .object({
        kind: z.enum(["noop", "summarizing"]).default("noop"),
        thresholdRatio: z.number().min(0.1).max(0.95).default(0.75),
        keepTailTurns: z.number().int().min(2).max(50).default(8),
        summarizerMaxOutputTokens: z.number().int().min(100).max(4000).default(800),
      })
      .default({}),
  })
  .default({});

const LlmConfigSchema = z
  .object({
    provider: z.enum(["xai", "openai", "anthropic", "gemini"]).default("xai"),
    model: z
      .object({
        reasoner: z.string().default("grok-4.20-reasoning"),
        composer: z.string().default("grok-4-1-fast-non-reasoning"),
        judge: z.string().default("grok-4-1-fast-non-reasoning"),
      })
      .default({}),
  })
  .default({});

const CredentialsConfigSchema = z
  .object({
    store: z
      .enum([
        "env",
        "file",
        "file+env",
        "encrypted-file",
        "encrypted-file+env",
        "keychain",
        "keychain+env",
      ])
      .default("env"),
    tenant: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .nullable()
      .default(null),
  })
  .default({});

const OrchestratorConfigSchema = z
  .object({
    perceiverMs: z.number().int().positive().default(120_000),
    reasonerMs: z.number().int().positive().default(300_000),
    consolidatorRunMs: z
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60 * 1000),
    consolidatorPollMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
  })
  .default({});

const ToolsConfigSchema = z
  .object({
    enableDestructive: z.boolean().default(false),
    workdir: z.string().optional(),
  })
  .default({});

const XConfigSchema = z
  .object({
    tier: z.enum(["basic", "pro", "enterprise"]).default("basic"),
    oauthRedirect: z.string().url().default("http://localhost:4567/callback"),
  })
  .default({});

const BrainctlConfigSchema = z
  .object({
    command: z.string().default("brainctl"),
    args: z.string().default("mcp"),
    remoteMcpUrl: z.string().url().nullable().default(null),
  })
  .default({});

export const StrandConfigSchema = z
  .object({
    mode: z.enum(["shadow", "gated", "live"]).default("shadow"),
    llm: LlmConfigSchema,
    credentials: CredentialsConfigSchema,
    budget: z.object({ defaults: BudgetDefaultsSchema }).default({ defaults: {} }),
    agent: AgentConfigSchema,
    orchestrator: OrchestratorConfigSchema,
    tools: ToolsConfigSchema,
    x: XConfigSchema,
    brainctl: BrainctlConfigSchema,
  })
  .default({});

export type StrandConfig = z.infer<typeof StrandConfigSchema>;

export interface LoadConfigOpts {
  /** Explicit path, overrides discovery. */
  path?: string;
  /** Don't log the resolution. Tests. */
  silent?: boolean;
}

export interface ResolvedConfig {
  config: StrandConfig;
  source: "explicit" | "cwd" | "home" | "defaults";
  path: string | null;
}

const CWD_CANDIDATES = ["strand.config.yaml", "strand.config.yml"];

export function loadConfig(opts: LoadConfigOpts = {}): ResolvedConfig {
  let source: ResolvedConfig["source"] = "defaults";
  let path: string | null = null;

  if (opts.path) {
    source = "explicit";
    path = resolve(opts.path);
  } else {
    for (const cand of CWD_CANDIDATES) {
      const p = resolve(process.cwd(), cand);
      if (existsSync(p)) {
        source = "cwd";
        path = p;
        break;
      }
    }
    if (!path) {
      const homeCandidate = resolve(homedir(), ".strand", "config.yaml");
      if (existsSync(homeCandidate)) {
        source = "home";
        path = homeCandidate;
      }
    }
  }

  let raw: unknown = {};
  if (path) {
    try {
      raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
    } catch (err) {
      throw new Error(
        `failed to parse config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const parsed = StrandConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid strand config${path ? ` at ${path}` : ""}:\n${JSON.stringify(parsed.error.format(), null, 2)}`,
    );
  }

  if (!opts.silent) {
    log.debug(
      { svc: "cli", source, path, mode: parsed.data.mode, provider: parsed.data.llm.provider },
      "cli.config.loaded",
    );
  }

  return { config: parsed.data, source, path };
}

/**
 * Apply the config to process.env where feasible. Called once at CLI entry
 * so downstream modules (auth/, clients/llm/) see a consistent env. Env vars
 * already present are NOT overwritten — explicit env wins.
 */
export function applyConfigToEnv(cfg: StrandConfig): void {
  const set = (k: string, v: string | undefined): void => {
    if (v === undefined) return;
    if (process.env[k] === undefined || process.env[k] === "") {
      Object.assign(process.env, { [k]: v });
    }
  };

  set("STRAND_MODE", cfg.mode);
  set("LLM_PROVIDER", cfg.llm.provider);
  set("LLM_MODEL_REASONER", cfg.llm.model.reasoner);
  set("LLM_MODEL_COMPOSER", cfg.llm.model.composer);
  set("LLM_MODEL_JUDGE", cfg.llm.model.judge);
  set("STRAND_CREDENTIAL_STORE", cfg.credentials.store);
  if (cfg.credentials.tenant) set("STRAND_TENANT", cfg.credentials.tenant);
  set("TIER", cfg.x.tier);
  set("X_OAUTH_REDIRECT_URI", cfg.x.oauthRedirect);
  set("BRAINCTL_COMMAND", cfg.brainctl.command);
  set("BRAINCTL_ARGS", cfg.brainctl.args);
  if (cfg.brainctl.remoteMcpUrl) set("BRAINCTL_REMOTE_MCP_URL", cfg.brainctl.remoteMcpUrl);
}
