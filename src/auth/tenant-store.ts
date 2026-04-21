import type { CredentialStore } from "./credentials";

/**
 * Tenant-scoped credential store — decorator that namespaces every key with a
 * tenant id. Enables multi-tenant Strand deployments where each user brings
 * their own keys against a shared process.
 *
 *   base.get("XAI_API_KEY")                         // single-tenant
 *   tenant("acme").get("XAI_API_KEY")               // → base.get("tenant:acme:XAI_API_KEY")
 *
 * `list()` strips the prefix so callers see the unscoped keys. `setMany()` is
 * atomic through the base store's setMany when present.
 *
 * Tenant ids: alphanumeric + `_`/`-`/`.` — reject anything with `:` to keep the
 * delimiter unambiguous.
 */
export class TenantScopedCredentialStore implements CredentialStore {
  readonly name: string;
  private readonly prefix: string;

  constructor(
    private readonly base: CredentialStore,
    public readonly tenantId: string,
  ) {
    if (!/^[A-Za-z0-9_.-]+$/.test(tenantId)) {
      throw new Error(
        `TenantScopedCredentialStore: invalid tenantId "${tenantId}" — only A-Z a-z 0-9 _ - . allowed`,
      );
    }
    this.prefix = `tenant:${tenantId}:`;
    this.name = `tenant(${tenantId})/${base.name}`;
  }

  private scope(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<string | undefined> {
    return this.base.get(this.scope(key));
  }

  async set(key: string, value: string): Promise<void> {
    return this.base.set(this.scope(key), value);
  }

  async delete(key: string): Promise<void> {
    return this.base.delete(this.scope(key));
  }

  async list(): Promise<string[]> {
    const all = await this.base.list();
    const out: string[] = [];
    for (const k of all) {
      if (k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    const scoped: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) scoped[this.scope(k)] = v;
    if (this.base.setMany) return this.base.setMany(scoped);
    for (const [k, v] of Object.entries(scoped)) {
      await this.base.set(k, v);
    }
  }
}
