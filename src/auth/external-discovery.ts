/**
 * External credential discovery — reads credentials written by other CLI
 * tools installed on the same machine.
 *
 * Hard constraints:
 *   #3 — `oauth_external` is local-only.
 *   #4 — Anthropic routes third-party OAuth to `extra_usage` billing pool;
 *         must surface warning before first call.
 *   #5 — Discovery NEVER auto-activates a provider. Results are offered as
 *         selectable sources in the picker.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface ExternalCredentialResult {
  readonly found: boolean;
  readonly path: string;
  readonly localOnly: true;
  readonly billingWarning?: string;
  readonly token?: string;
}

const ANTHROPIC_BILLING_WARNING =
  "Anthropic routes third-party OAuth clients to the extra_usage billing pool, " +
  "which is empty for most users. You may incur metered API charges on your " +
  "Claude Pro/Max subscription. See hermes-agent issue #12905.";

/**
 * Claude Code credentials file schema — only the fields we need.
 * Path: `~/.claude/.credentials.json`
 */
const ClaudeCodeCredentialsSchema = z.object({
  accessToken: z.string().min(1).optional(),
  oauthAccessToken: z.string().min(1).optional(),
});

/**
 * Discover Claude Code OAuth credentials on this machine.
 *
 * Returns found=true if `~/.claude/.credentials.json` exists and contains a
 * usable token. The billing warning is ALWAYS attached when found (hard
 * constraint #4). The caller MUST surface this warning before the first call.
 */
export function discoverClaudeCodeCredentials(homeOverride?: string): ExternalCredentialResult {
  const home = homeOverride ?? homedir();
  const credPath = join(home, ".claude", ".credentials.json");

  if (!existsSync(credPath)) {
    return { found: false, path: credPath, localOnly: true };
  }

  try {
    const raw = readFileSync(credPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const creds = ClaudeCodeCredentialsSchema.parse(parsed);
    const token = creds.oauthAccessToken ?? creds.accessToken;
    if (!token) {
      return { found: false, path: credPath, localOnly: true };
    }
    return {
      found: true,
      path: credPath,
      localOnly: true,
      billingWarning: ANTHROPIC_BILLING_WARNING,
      token,
    };
  } catch {
    return { found: false, path: credPath, localOnly: true };
  }
}

/**
 * Gemini CLI credentials file schema — only the fields we need.
 * Path: varies by platform; typically `~/.config/gemini-cli/oauth_creds.json`
 * or `~/.qwen/oauth_creds.json`.
 */
const GeminiCliCredentialsSchema = z.object({
  access_token: z.string().min(1).optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  refresh_token: z.string().optional(),
});

const GEMINI_CLI_PATHS = [
  join(".config", "gemini-cli", "oauth_creds.json"),
  join(".qwen", "oauth_creds.json"),
] as const;

/**
 * Discover gemini-cli OAuth credentials on this machine.
 *
 * Checks known credential paths. Returns found=true if any contains a
 * usable access token. No billing warning for Gemini (Google handles
 * third-party OAuth differently).
 */
export function discoverGeminiCliCredentials(homeOverride?: string): ExternalCredentialResult {
  const home = homeOverride ?? homedir();

  for (const relPath of GEMINI_CLI_PATHS) {
    const credPath = join(home, relPath);
    if (!existsSync(credPath)) continue;

    try {
      const raw = readFileSync(credPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const creds = GeminiCliCredentialsSchema.parse(parsed);
      if (creds.access_token) {
        return {
          found: true,
          path: credPath,
          localOnly: true,
          token: creds.access_token,
        };
      }
    } catch {}
  }

  const firstPath = GEMINI_CLI_PATHS[0] ?? "";
  const defaultPath = join(home, firstPath);
  return { found: false, path: defaultPath, localOnly: true };
}

/**
 * Run all external credential discovery probes. Returns a map of
 * provider ID to discovery result. Caller decides what to show in the picker.
 *
 * IMPORTANT: Discovery NEVER auto-activates a provider (hard constraint #5).
 */
export function discoverAllExternalCredentials(homeOverride?: string): {
  anthropic: ExternalCredentialResult;
  gemini: ExternalCredentialResult;
} {
  return {
    anthropic: discoverClaudeCodeCredentials(homeOverride),
    gemini: discoverGeminiCliCredentials(homeOverride),
  };
}
