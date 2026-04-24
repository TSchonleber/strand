import { log } from "@/util/log";
import type { CredentialStore } from "./credentials";
import { MissingCredentialError } from "./credentials";
import { EncryptedFileCredentialStore } from "./encrypted-file-store";
import { EnvCredentialStore } from "./env-store";
import { FileCredentialStore } from "./file-store";
import { KeychainCredentialStore } from "./keychain-store";
import { OAuthCredentialStore } from "./oauth-store";
import { makeXOAuthStrategy } from "./oauth-x";
import { TenantScopedCredentialStore } from "./tenant-store";

export { MissingCredentialError } from "./credentials";
export type { CredentialStore } from "./credentials";
export { EncryptedFileCredentialStore } from "./encrypted-file-store";
export { EnvCredentialStore } from "./env-store";
export { FileCredentialStore } from "./file-store";
export { KeychainCredentialStore } from "./keychain-store";
export { OAuthCredentialStore, type OAuthProviderStrategy } from "./oauth-store";
export { makeXOAuthStrategy } from "./oauth-x";
export { TenantScopedCredentialStore } from "./tenant-store";

// Cockpit auth — provider registry, auth store, external discovery, device-code
export {
  type AuthMode,
  type AuthSource,
  type AuthType,
  type HostConstraint,
  type ProviderId,
  type ProviderDef,
  ProviderIdSchema,
  AuthTypeSchema,
  availableAuthModes,
  getProvider,
  listProviders,
  requiresBaseUrl,
} from "./provider-registry";
export {
  type AuthEntry,
  type AuthStoreData,
  AuthStoreDataSchema,
  CockpitAuthStore,
} from "./auth-store";
export {
  type ExternalCredentialResult,
  discoverAllExternalCredentials,
  discoverClaudeCodeCredentials,
  discoverGeminiCliCredentials,
} from "./external-discovery";
export {
  type DeviceCodeHttpClient,
  type TokenPollResult,
  type TokenSet,
  type UserCodeResponse,
  DeviceCodeError,
  OpenAIDeviceCodeClient,
  runDeviceCodeFlow,
} from "./device-code";

let _default: CredentialStore | null = null;

/**
 * Build the default credential store stack.
 *
 * Selection via `STRAND_CREDENTIAL_STORE` env:
 *   "env"             → EnvCredentialStore (default — reads `.env`)
 *   "file"            → FileCredentialStore (~/.strand/credentials.json, 0600)
 *   "file+env"        → FileCredentialStore w/ EnvCredentialStore fallback
 *   "encrypted-file"  → EncryptedFileCredentialStore (AES-256-GCM + scrypt)
 *                       requires STRAND_CREDENTIAL_PASSPHRASE
 *   "keychain"        → KeychainCredentialStore (@napi-rs/keyring)
 *
 * Additional env: `STRAND_TENANT` wraps the store in a
 * TenantScopedCredentialStore, namespacing every key with `tenant:<id>:`.
 *
 * Wrapped in an OAuthCredentialStore by default (X refresh strategy
 * preregistered). Pass `{ withOauth: false }` to skip.
 */
export function credentials(opts?: {
  withOauth?: boolean;
  override?: CredentialStore;
}): CredentialStore {
  if (opts?.override) return opts.override;
  if (_default) return _default;

  const mode = process.env["STRAND_CREDENTIAL_STORE"] ?? "env";
  const tenantId = process.env["STRAND_TENANT"];
  let base: CredentialStore;
  switch (mode) {
    case "file":
      base = new FileCredentialStore();
      break;
    case "file+env":
      base = new ChainedCredentialStore([new FileCredentialStore(), new EnvCredentialStore()]);
      break;
    case "encrypted-file":
      base = new EncryptedFileCredentialStore();
      break;
    case "encrypted-file+env":
      base = new ChainedCredentialStore([
        new EncryptedFileCredentialStore(),
        new EnvCredentialStore(),
      ]);
      break;
    case "keychain":
      base = new KeychainCredentialStore();
      break;
    case "keychain+env":
      base = new ChainedCredentialStore([new KeychainCredentialStore(), new EnvCredentialStore()]);
      break;
    default:
      base = new EnvCredentialStore();
  }

  if (tenantId) {
    base = new TenantScopedCredentialStore(base, tenantId);
  }

  if (opts?.withOauth !== false) {
    const oauth = new OAuthCredentialStore(base);
    oauth.registerStrategy(makeXOAuthStrategy({ store: base }));
    _default = oauth;
  } else {
    _default = base;
  }

  log.info(
    {
      svc: "auth",
      store: _default.name,
      mode,
      tenant: tenantId ?? null,
    },
    "auth.credentials.initialized",
  );
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
