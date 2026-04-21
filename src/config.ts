import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as dotenv from "dotenv";
import YAML from "yaml";
import { z } from "zod";

dotenv.config();

// ─── Environment ─────────────────────────────────────────────

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  STRAND_MODE: z.enum(["shadow", "gated", "live"]).default("shadow"),

  // ─── LLM provider (agnostic) ───────────────────────────────
  LLM_PROVIDER: z.enum(["xai", "openai", "anthropic", "gemini"]).default("xai"),
  LLM_MODEL_REASONER: z.string().default("grok-4.20-reasoning"),
  LLM_MODEL_COMPOSER: z.string().default("grok-4-1-fast-non-reasoning"),
  LLM_MODEL_JUDGE: z.string().default("grok-4-1-fast-non-reasoning"),
  // Per-provider credentials (factory picks the one matching LLM_PROVIDER)
  XAI_API_KEY: z.string().optional(),
  XAI_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(), // override for Ollama / Groq / Together / LM Studio
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  GEMINI_API_KEY: z.string().optional(),

  X_CLIENT_ID: z.string().min(1),
  X_CLIENT_SECRET: z.string().min(1),
  X_BEARER_TOKEN: z.string().optional(),
  X_USER_ID: z.string().optional(),
  X_USER_ACCESS_TOKEN: z.string().optional(),
  X_USER_REFRESH_TOKEN: z.string().optional(),
  X_USER_TOKEN_EXPIRES_AT: z.string().optional(),
  X_OAUTH_REDIRECT_URI: z.string().url().default("http://localhost:4567/callback"),

  BRAINCTL_COMMAND: z.string().default("brainctl"),
  BRAINCTL_ARGS: z.string().default("mcp"),
  BRAINCTL_AGENT_ID: z.string().default("strand"),
  BRAINCTL_REMOTE_MCP_URL: z.string().url().optional(),
  BRAINCTL_REMOTE_MCP_TOKEN: z.string().optional(),

  REDIS_URL: z.string().optional(),
  DATABASE_PATH: z.string().default("./data/strand.db"),

  REVIEW_SINK: z.enum(["stdout", "slack"]).default("stdout"),
  SLACK_WEBHOOK_URL: z.string().url().optional(),

  TIER: z.enum(["basic", "pro", "enterprise"]).default("basic"),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid env:\n", parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
})();

// ─── YAML configs ────────────────────────────────────────────

export const PersonaConfigSchema = z.object({
  handle: z.string(),
  voice: z.string(),
  goals: z.array(z.string()).min(1),
  topics: z.array(z.string()).min(1),
  banned_topics: z.array(z.string()).default([]),
  style_notes: z.array(z.string()).default([]),
});

export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

export const PoliciesConfigSchema = z.object({
  mode: z.enum(["shadow", "gated", "live"]),
  ramp_multiplier: z.number().min(0).max(1).default(0.5),
  caps_per_day: z.object({
    posts: z.number().int().nonnegative(),
    replies: z.number().int().nonnegative(),
    quotes: z.number().int().nonnegative(),
    follows: z.number().int().nonnegative(),
    unfollows: z.number().int().nonnegative(),
    likes: z.number().int().nonnegative(),
    bookmarks: z.number().int().nonnegative(),
    dms: z.number().int().nonnegative(),
  }),
  caps_per_hour: z.object({
    follows: z.number().int().nonnegative(),
    replies: z.number().int().nonnegative(),
  }),
  cooldowns_minutes: z.object({
    per_target_any: z.number().int().nonnegative(),
    follow_after_unfollow_days: z.number().int().nonnegative(),
    dm_per_target_days: z.number().int().nonnegative(),
  }),
  thresholds: z.object({
    min_relevance_reply: z.number().min(0).max(1),
    min_relevance_quote: z.number().min(0).max(1),
    min_relevance_dm: z.number().min(0).max(1),
    max_reply_cosine_7d: z.number().min(0).max(1),
    min_confidence_no_review: z.number().min(0).max(1),
  }),
  diversity: z.object({
    max_share_per_cluster: z.number().min(0).max(1),
    max_share_per_kind: z.number().min(0).max(1),
  }),
  human_review_required: z.object({
    dm: z.boolean(),
    post: z.boolean(),
    low_confidence: z.boolean(),
    new_topic: z.boolean(),
  }),
});

export type PoliciesConfig = z.infer<typeof PoliciesConfigSchema>;

export const SeedEntitiesConfigSchema = z.object({
  watch_users: z.array(z.string()).default([]),
  watch_topics: z.array(z.string()).default([]),
  banned_users: z.array(z.string()).default([]),
});

export type SeedEntitiesConfig = z.infer<typeof SeedEntitiesConfigSchema>;

// ─── Loaders ─────────────────────────────────────────────────

function loadYaml<T extends z.ZodTypeAny>(path: string, schema: T): z.infer<T> {
  const raw = readFileSync(resolve(process.cwd(), path), "utf8");
  const parsed = YAML.parse(raw);
  return schema.parse(parsed);
}

export const persona = loadYaml("config/persona.yaml", PersonaConfigSchema);
export const policies = loadYaml("config/policies.yaml", PoliciesConfigSchema);
export const seedEntities = loadYaml("config/seed-entities.yaml", SeedEntitiesConfigSchema);

export function effectiveCap(kind: keyof PoliciesConfig["caps_per_day"]): number {
  const base = policies.caps_per_day[kind];
  return Math.floor(base * policies.ramp_multiplier);
}
