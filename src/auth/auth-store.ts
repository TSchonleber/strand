/**
 * Cockpit auth store — persists the user's active provider choice and
 * per-provider auth state to `~/.strand/auth.json`.
 *
 * Shape mirrors the spec (S3 Auth store shape):
 *   { active_provider, providers, suppressed_sources }
 *
 * Rules (verbatim from hermes):
 *   1. No implicit use of external credentials (hard constraint #5).
 *   2. `suppressed_sources` blacklists a discovery path per provider.
 *   3. Single-writer file lock during refresh.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AuthType, ProviderId } from "./provider-registry";
import { ProviderIdSchema } from "./provider-registry";

export const ApiKeyEntrySchema = z.object({
  auth_type: z.literal("api_key"),
  source: z.string().min(1),
});

export const OAuthDeviceCodeEntrySchema = z.object({
  auth_type: z.literal("oauth_device_code"),
  tokens: z.record(z.string()),
  expires_at: z.string().datetime(),
});

export const OAuthExternalEntrySchema = z.object({
  auth_type: z.literal("oauth_external"),
  credential_path: z.string().min(1),
});

export const AuthEntrySchema = z.discriminatedUnion("auth_type", [
  ApiKeyEntrySchema,
  OAuthDeviceCodeEntrySchema,
  OAuthExternalEntrySchema,
]);
export type AuthEntry = z.infer<typeof AuthEntrySchema>;

export const AuthStoreDataSchema = z.object({
  active_provider: ProviderIdSchema.nullable(),
  providers: z.record(ProviderIdSchema, AuthEntrySchema),
  suppressed_sources: z.record(ProviderIdSchema, z.array(z.string())),
});
export type AuthStoreData = z.infer<typeof AuthStoreDataSchema>;

function emptyStore(): AuthStoreData {
  return {
    active_provider: null,
    providers: {},
    suppressed_sources: {},
  };
}

export interface CockpitAuthStoreOpts {
  /** Override the default path for testing. */
  path?: string;
}

/**
 * Manages `~/.strand/auth.json` with single-writer locking.
 *
 * All mutations go through `update()` which holds a lock file for the
 * duration of the write. Reads are lock-free (stale reads are acceptable
 * since the only writer is the cockpit process on this machine).
 */
export class CockpitAuthStore {
  readonly path: string;
  private lockHeld = false;

  constructor(opts?: CockpitAuthStoreOpts) {
    this.path = opts?.path ?? join(homedir(), ".strand", "auth.json");
  }

  read(): AuthStoreData {
    if (!existsSync(this.path)) return emptyStore();
    const raw = readFileSync(this.path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return AuthStoreDataSchema.parse(parsed);
  }

  /**
   * Apply `fn` to the current store state and write the result atomically.
   * Acquires a local lock to prevent concurrent writes during refresh flows.
   */
  update(fn: (current: AuthStoreData) => AuthStoreData): AuthStoreData {
    this.acquireLock();
    try {
      const current = this.read();
      const next = AuthStoreDataSchema.parse(fn(current));
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
      });
      return next;
    } finally {
      this.releaseLock();
    }
  }

  activeProvider(): string | null {
    return this.read().active_provider;
  }

  setActiveProvider(id: ProviderId, entry: AuthEntry): AuthStoreData {
    return this.update((s) => ({
      ...s,
      active_provider: id,
      providers: { ...s.providers, [id]: entry },
    }));
  }

  clearProvider(id: ProviderId): AuthStoreData {
    return this.update((s) => {
      const providers = { ...s.providers };
      delete providers[id];
      return {
        ...s,
        active_provider: s.active_provider === id ? null : s.active_provider,
        providers,
      };
    });
  }

  isSuppressed(providerId: ProviderId, source: string): boolean {
    const data = this.read();
    const list = data.suppressed_sources[providerId];
    return list?.includes(source) ?? false;
  }

  suppressSource(providerId: ProviderId, source: string): AuthStoreData {
    return this.update((s) => {
      const existing = s.suppressed_sources[providerId] ?? [];
      if (existing.includes(source)) return s;
      return {
        ...s,
        suppressed_sources: {
          ...s.suppressed_sources,
          [providerId]: [...existing, source],
        },
      };
    });
  }

  providerAuthType(id: ProviderId): AuthType | null {
    const data = this.read();
    const entry = data.providers[id];
    return (entry?.auth_type as AuthType) ?? null;
  }

  private acquireLock(): void {
    if (this.lockHeld) throw new Error("CockpitAuthStore: lock already held (re-entrant write)");
    const lockPath = `${this.path}.lock`;
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      this.lockHeld = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `CockpitAuthStore: lock file exists at ${lockPath}. Another process may be writing. Remove manually if stale.`,
        );
      }
      throw err;
    }
  }

  private releaseLock(): void {
    const lockPath = `${this.path}.lock`;
    try {
      unlinkSync(lockPath);
    } catch {
      // lock file already gone — acceptable
    }
    this.lockHeld = false;
  }
}
