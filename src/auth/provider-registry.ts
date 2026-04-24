/**
 * Provider registry — canonical list of supported LLM providers and their
 * auth modes.
 *
 * v1 ships with exactly five providers (per spec S3). The `openai-compat`
 * entry covers any OpenAI-API-compatible endpoint via `baseURL`.
 *
 * Hard constraints enforced here:
 *   #3 — `oauth_external` is local-only; `oauth_device_code` + `api_key` work anywhere.
 *   #4 — Anthropic `oauth_external` carries a billing warning.
 *   #5 — No implicit activation from env vars.
 */

import { z } from "zod";

export const ProviderIdSchema = z.enum(["anthropic", "openai", "xai", "gemini", "openai-compat"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const AuthTypeSchema = z.enum(["api_key", "oauth_device_code", "oauth_external"]);
export type AuthType = z.infer<typeof AuthTypeSchema>;

export const AuthSourceSchema = z.enum(["env", "strand_store", "external_cli"]);
export type AuthSource = z.infer<typeof AuthSourceSchema>;

export const HostConstraintSchema = z.enum(["any", "local_only"]);
export type HostConstraint = z.infer<typeof HostConstraintSchema>;

export interface AuthMode {
  readonly type: AuthType;
  readonly source: AuthSource;
  readonly envKey?: string;
  readonly hostConstraint: HostConstraint;
  readonly billingWarning?: string;
}

export interface ProviderDef {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly primaryAuth: AuthMode;
  readonly secondaryAuth?: AuthMode;
  readonly baseUrlEnv?: string;
}

const ANTHROPIC_BILLING_WARNING =
  "Anthropic routes third-party OAuth clients to the extra_usage billing pool, " +
  "which is empty for most users. You may incur metered API charges on your " +
  "Claude Pro/Max subscription. See hermes-agent issue #12905.";

const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    primaryAuth: {
      type: "api_key",
      source: "env",
      envKey: "ANTHROPIC_API_KEY",
      hostConstraint: "any",
    },
    secondaryAuth: {
      type: "oauth_external",
      source: "external_cli",
      hostConstraint: "local_only",
      billingWarning: ANTHROPIC_BILLING_WARNING,
    },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    primaryAuth: {
      type: "api_key",
      source: "env",
      envKey: "OPENAI_API_KEY",
      hostConstraint: "any",
    },
    secondaryAuth: {
      type: "oauth_device_code",
      source: "strand_store",
      hostConstraint: "any",
    },
  },
  {
    id: "xai",
    displayName: "xAI",
    primaryAuth: {
      type: "api_key",
      source: "env",
      envKey: "XAI_API_KEY",
      hostConstraint: "any",
    },
  },
  {
    id: "gemini",
    displayName: "Gemini",
    primaryAuth: {
      type: "api_key",
      source: "env",
      envKey: "GEMINI_API_KEY",
      hostConstraint: "any",
    },
    secondaryAuth: {
      type: "oauth_external",
      source: "external_cli",
      hostConstraint: "local_only",
    },
  },
  {
    id: "openai-compat",
    displayName: "OpenAI-compatible",
    primaryAuth: {
      type: "api_key",
      source: "env",
      envKey: "OPENAI_API_KEY",
      hostConstraint: "any",
    },
    baseUrlEnv: "OPENAI_BASE_URL",
  },
] as const;

const REGISTRY = new Map<ProviderId, ProviderDef>(PROVIDERS.map((p) => [p.id, p]));

export function listProviders(): readonly ProviderDef[] {
  return PROVIDERS;
}

export function getProvider(id: ProviderId): ProviderDef | undefined {
  return REGISTRY.get(id);
}

export function availableAuthModes(id: ProviderId): readonly AuthMode[] {
  const def = REGISTRY.get(id);
  if (!def) return [];
  const modes: AuthMode[] = [def.primaryAuth];
  if (def.secondaryAuth) modes.push(def.secondaryAuth);
  return modes;
}

export function requiresBaseUrl(id: ProviderId): boolean {
  return id === "openai-compat";
}
