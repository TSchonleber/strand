import { log } from "@/util/log";
import type { CredentialStore } from "./credentials";
import { MissingCredentialError } from "./credentials";
import { EnvCredentialStore } from "./env-store";
import { FileCredentialStore } from "./file-store";
import { OAuthCredentialStore } from "./oauth-store";
import { makeXOAuthStrategy } from "./oauth-x";

export { MissingCredentialError } from "./credentials";
export type { CredentialStore } from "./credentials";
export { EnvCredentialStore } from "./env-store";
export { FileCredentialStore } from "./file-store";
export {
  OAuthCredentialStore,
  type OAuthProviderStrategy,
} from "./oauth-store";
export { makeXOAuthStrategy } from "./oauth-x";

let _default: CredentialStore | null = null;

/**
 * Build the default credential store stack.
 *
 * Selection via `STRAND_CREDENTIAL_STORE` env:
 *   unset / "env"   → EnvCredentialStore (reads `.env`; current behavior)
 *   "file"          → FileCredentialStore (~/.strand/credentials.json)
 *   "file+env"      → FileCredentialStore with Env fallback (file wins when set)
 *
 * Wrapped in an OAuthCredentialStore when any OAuth-backed provider is in
 * play (X: if X_CLIENT_ID + X_CLIENT_SECRET are resolvable). Strategies are
 * registered lazily — calling `credentials()` with `withOauth=true` returns
 * a store that refreshes on first access.
 */
export function credentials(opts?: {
  withOauth?: boolean;
  override?: CredentialStore;
}): CredentialStore {
  if (opts?.override) return opts.override;
  if (_default) return _default;

  const mode = process.env["STRAND_CREDENTIAL_STORE"] ?? "env";
  let base: CredentialStore;
  if (mode === "file") {
    base = new FileCredentialStore();
  } else if (mode === "file+env") {
    base = new ChainedCredentialStore([new FileCredentialStore(), new EnvCredentialStore()]);
  } else {
    base = new EnvCredentialStore();
  }

  if (opts?.withOauth !== false) {
    const oauth = new OAuthCredentialStore(base);
    oauth.registerStrategy(makeXOAuthStrategy({ store: base }));
    _default = oauth;
  } else {
    _default = base;
  }

  log.info({ svc: "auth", store: _default.name, mode }, "auth.credentials.initialized");
  return _default;
}

/** Resolve a required credential; throws MissingCredentialError if absent. */
export async function requireCredential(store: CredentialStore, key: string): Promise<string> {
  const v = await store.get(key);
  if (!v) throw new MissingCredentialError(key, store.name);
  return v;
}

/** Reset the singleton — test helper. */
export function _resetCredentialsForTests(): void {
  _default = null;
}

/**
 * Chain multiple stores — first hit wins on read. Writes go to the first store
 * only. Useful for "file overrides env": file store first, env as fallback.
 */
export class ChainedCredentialStore implements CredentialStore {
  readonly name: string;
  constructor(private readonly stores: CredentialStore[]) {
    if (stores.length === 0) throw new Error("ChainedCredentialStore requires >= 1 store");
    this.name = `chain(${stores.map((s) => s.name).join("+")})`;
  }

  async get(key: string): Promise<string | undefined> {
    for (const s of this.stores) {
      const v = await s.get(key);
      if (v) return v;
    }
    return undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const first = this.stores[0];
    if (!first) throw new Error("ChainedCredentialStore: empty stores");
    return first.set(key, value);
  }

  async delete(key: string): Promise<void> {
    for (const s of this.stores) {
      await s.delete(key);
    }
  }

  async list(): Promise<string[]> {
    const set = new Set<string>();
    for (const s of this.stores) {
      for (const k of await s.list()) set.add(k);
    }
    return [...set];
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    const first = this.stores[0];
    if (!first) throw new Error("ChainedCredentialStore: empty stores");
    if (first.setMany) return first.setMany(entries);
    for (const [k, v] of Object.entries(entries)) {
      await first.set(k, v);
    }
  }
}
