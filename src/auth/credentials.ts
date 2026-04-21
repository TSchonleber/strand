/**
 * Credential store — bring-your-own-key abstraction.
 *
 * Strand resolves provider credentials (LLM API keys, X OAuth tokens,
 * brainctl MCP bearer) through this interface rather than hardcoding
 * `process.env` lookups. Deployments / users plug in whichever backend fits:
 *
 *   EnvCredentialStore   — reads process.env (default; drop-in for current behavior)
 *   FileCredentialStore  — JSON file at ~/.strand/credentials.json (0600 perms)
 *   OAuthCredentialStore — decorator over a base store with auto-refresh
 *
 * Keys are flat strings matching env-var-style names (XAI_API_KEY,
 * X_USER_ACCESS_TOKEN, BRAINCTL_REMOTE_MCP_TOKEN, …). Multi-tenant support
 * is a future decorator (scope the key by tenant id before lookup).
 *
 * Thread safety: backends MUST handle concurrent get/set correctly. File
 * store uses atomic rename; OAuth store uses a per-key promise lock during
 * refresh.
 */

export interface CredentialStore {
  /** Short name for telemetry — "env", "file", "oauth", "keychain", ... */
  readonly name: string;

  /** Return the current value for `key`, or `undefined` if unset. */
  get(key: string): Promise<string | undefined>;

  /** Persist `value` under `key`. Throws if the backend is read-only. */
  set(key: string, value: string): Promise<void>;

  /** Remove `key`. No-op if it doesn't exist. */
  delete(key: string): Promise<void>;

  /** List all keys the backend can currently surface. Useful for `strand keys list`. */
  list(): Promise<string[]>;

  /** Atomic multi-key write. Used by OAuth refresh so access+refresh tokens never diverge. */
  setMany?(entries: Record<string, string>): Promise<void>;
}

/** Common error the Factory / adapters throw when a required key is missing. */
export class MissingCredentialError extends Error {
  constructor(
    public readonly key: string,
    public readonly store: string,
  ) {
    super(`missing credential: ${key} (store=${store})`);
    this.name = "MissingCredentialError";
  }
}
