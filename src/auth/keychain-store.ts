import { log } from "@/util/log";
import type { CredentialStore } from "./credentials";

/**
 * OS-native keyring credential store — macOS Keychain, Windows Credential
 * Manager, Linux Secret Service (libsecret).
 *
 * Backed by `@napi-rs/keyring` — zero runtime deps beyond Node + the
 * platform keyring service. Each credential is stored as a separate entry
 * under the service name (default "strand").
 *
 * An in-memory index of written keys is kept so `list()` works without
 * enumerating the system keyring (which most OS APIs don't expose
 * cleanly). The index is persisted alongside the secrets — under the same
 * service, in an entry named `__index__` holding a JSON array of keys.
 *
 * Lazy import: `@napi-rs/keyring` is a dynamic dep — if it's not installed,
 * construction throws a clear error rather than crashing imports for users
 * who never touch keychain mode.
 */

interface KeyringEntryClass {
  new (
    service: string,
    account: string,
  ): {
    getPassword(): Promise<string | null> | string | null;
    setPassword(password: string): Promise<void> | void;
    deletePassword(): Promise<boolean> | boolean;
  };
}

const INDEX_ACCOUNT = "__index__";

export class KeychainCredentialStore implements CredentialStore {
  readonly name = "keychain";
  private readonly service: string;
  private readonly Entry: KeyringEntryClass;
  private indexCache: Set<string> | null = null;

  constructor(opts?: { service?: string; entryClass?: KeyringEntryClass }) {
    this.service = opts?.service ?? "strand";
    if (opts?.entryClass) {
      this.Entry = opts.entryClass;
    } else {
      this.Entry = loadKeyringEntry();
    }
  }

  async get(key: string): Promise<string | undefined> {
    const entry = new this.Entry(this.service, key);
    const v = await Promise.resolve(entry.getPassword());
    return v == null || v.length === 0 ? undefined : v;
  }

  async set(key: string, value: string): Promise<void> {
    const entry = new this.Entry(this.service, key);
    await Promise.resolve(entry.setPassword(value));
    const idx = await this.loadIndex();
    if (!idx.has(key)) {
      idx.add(key);
      await this.saveIndex(idx);
    }
  }

  async delete(key: string): Promise<void> {
    const entry = new this.Entry(this.service, key);
    try {
      await Promise.resolve(entry.deletePassword());
    } catch (err) {
      // Some keyring backends throw "not found" — idempotent delete.
      log.debug({ svc: "auth", store: this.name, err }, "auth.keychain.delete_miss");
    }
    const idx = await this.loadIndex();
    if (idx.delete(key)) await this.saveIndex(idx);
  }

  async list(): Promise<string[]> {
    const idx = await this.loadIndex();
    return [...idx];
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    // OS keyrings don't expose batch APIs — sequential set. Index updated once.
    const idx = await this.loadIndex();
    for (const [k, v] of Object.entries(entries)) {
      const entry = new this.Entry(this.service, k);
      await Promise.resolve(entry.setPassword(v));
      idx.add(k);
    }
    await this.saveIndex(idx);
  }

  private async loadIndex(): Promise<Set<string>> {
    if (this.indexCache) return this.indexCache;
    const entry = new this.Entry(this.service, INDEX_ACCOUNT);
    const raw = await Promise.resolve(entry.getPassword());
    if (!raw) {
      this.indexCache = new Set();
      return this.indexCache;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.indexCache = new Set(parsed.filter((x) => typeof x === "string"));
      } else {
        this.indexCache = new Set();
      }
    } catch {
      this.indexCache = new Set();
    }
    return this.indexCache;
  }

  private async saveIndex(idx: Set<string>): Promise<void> {
    const entry = new this.Entry(this.service, INDEX_ACCOUNT);
    await Promise.resolve(entry.setPassword(JSON.stringify([...idx])));
    this.indexCache = idx;
  }
}

function loadKeyringEntry(): KeyringEntryClass {
  try {
    // Optional dep — resolved at runtime via createRequire so Node/ESM
    // doesn't hoist the import and hard-fail when the package is absent.
    // biome-ignore lint/suspicious/noExplicitAny: module resolution at boundary
    const req: (id: string) => any = Function("id", "return require(id)") as never;
    const mod = req("@napi-rs/keyring");
    const Entry: KeyringEntryClass | undefined = mod?.Entry;
    if (!Entry) {
      throw new Error("@napi-rs/keyring loaded but did not expose `Entry`");
    }
    return Entry;
  } catch (err) {
    throw new Error(
      `KeychainCredentialStore requires \`@napi-rs/keyring\`. Install with: pnpm add @napi-rs/keyring\n(original error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
