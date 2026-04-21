import { log } from "@/util/log";
import type { CredentialStore } from "./credentials";

/**
 * OAuth credential store — decorator over a base store that handles token
 * refresh + atomic rotation.
 *
 * For each OAuth-backed provider (X first; more later), register a refresh
 * strategy. When `get(accessKey)` is called and the stored token is near
 * expiry, we transparently run the refresh flow, persist the new token set
 * atomically (access + refresh + expiry in one `setMany()`), and return the
 * fresh access token.
 *
 * Concurrent refresh collisions are prevented via a per-provider promise lock
 * — callers awaiting during a refresh get the same resolved token.
 *
 * This interface is provider-agnostic. Strategies live in sibling files
 * (`oauth-x.ts` etc.). Add a new provider by registering its strategy.
 */

export interface OAuthProviderStrategy {
  /** Short name — "x", "google", etc. */
  readonly name: string;
  /** Env-style key that holds the current access token. */
  readonly accessTokenKey: string;
  /** Env-style key that holds the refresh token. */
  readonly refreshTokenKey: string;
  /** Env-style key that holds the ISO-8601 expiry timestamp. */
  readonly expiresAtKey: string;
  /**
   * Perform the refresh flow given the current refresh token. Returns the
   * new token set. The decorator persists it atomically via store.setMany().
   *
   * Throws on unrecoverable failure (revoked refresh token, provider 4xx).
   */
  refresh(args: { refreshToken: string }): Promise<{
    accessToken: string;
    /** May be the SAME refresh token (non-rotating) or a NEW one (rotating). */
    refreshToken?: string;
    expiresAt: string;
  }>;
  /** How many seconds of headroom to refresh before expiry. Default 60. */
  refreshWindowSeconds?: number;
}

export class OAuthCredentialStore implements CredentialStore {
  readonly name = "oauth";
  private readonly strategies = new Map<string, OAuthProviderStrategy>();
  private readonly refreshLocks = new Map<string, Promise<void>>();

  constructor(private readonly base: CredentialStore) {}

  registerStrategy(strategy: OAuthProviderStrategy): void {
    this.strategies.set(strategy.accessTokenKey, strategy);
    log.info(
      {
        svc: "auth",
        store: this.name,
        provider: strategy.name,
        accessKey: strategy.accessTokenKey,
      },
      "auth.oauth.strategy_registered",
    );
  }

  async get(key: string): Promise<string | undefined> {
    const strategy = this.strategies.get(key);
    if (!strategy) {
      return this.base.get(key);
    }
    await this.refreshIfNeeded(strategy);
    return this.base.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    return this.base.set(key, value);
  }

  async delete(key: string): Promise<void> {
    return this.base.delete(key);
  }

  async list(): Promise<string[]> {
    return this.base.list();
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    if (this.base.setMany) return this.base.setMany(entries);
    // Fallback: best-effort sequential set (loses atomicity — log it).
    log.warn({ svc: "auth", store: this.base.name }, "auth.oauth.base_store_no_setmany_non_atomic");
    for (const [k, v] of Object.entries(entries)) {
      await this.base.set(k, v);
    }
  }

  /**
   * Refresh NOW regardless of expiry. Used by `oauth-setup` scripts or by
   * callers that just observed a 401.
   */
  async refreshNow(accessKey: string): Promise<void> {
    const strategy = this.strategies.get(accessKey);
    if (!strategy) throw new Error(`no OAuth strategy registered for key: ${accessKey}`);
    await this.runRefresh(strategy);
  }

  private async refreshIfNeeded(strategy: OAuthProviderStrategy): Promise<void> {
    const windowSec = strategy.refreshWindowSeconds ?? 60;
    const expiresAt = await this.base.get(strategy.expiresAtKey);
    if (expiresAt) {
      const expMs = Date.parse(expiresAt);
      if (Number.isNaN(expMs)) return;
      if (expMs - Date.now() > windowSec * 1000) return;
    } else {
      return; // no expiry recorded; trust the caller
    }
    await this.runRefresh(strategy);
  }

  private async runRefresh(strategy: OAuthProviderStrategy): Promise<void> {
    const lockKey = strategy.accessTokenKey;
    const existing = this.refreshLocks.get(lockKey);
    if (existing) return existing;

    // Register the lock SYNCHRONOUSLY before any await — otherwise concurrent
    // callers race past the `if (existing)` check while the first caller is
    // still awaiting base.get(refreshToken), and all of them spin up parallel
    // refresh() calls.
    const promise = (async () => {
      const refreshToken = await this.base.get(strategy.refreshTokenKey);
      if (!refreshToken) {
        throw new Error(`OAuth refresh failed: no refresh token at ${strategy.refreshTokenKey}`);
      }
      log.info({ svc: "auth", store: this.name, provider: strategy.name }, "auth.oauth.refreshing");
      const fresh = await strategy.refresh({ refreshToken });
      const update: Record<string, string> = {
        [strategy.accessTokenKey]: fresh.accessToken,
        [strategy.expiresAtKey]: fresh.expiresAt,
      };
      if (fresh.refreshToken) {
        update[strategy.refreshTokenKey] = fresh.refreshToken;
      }
      await this.setMany(update);
      log.info(
        {
          svc: "auth",
          store: this.name,
          provider: strategy.name,
          rotated: Boolean(fresh.refreshToken),
          expiresAt: fresh.expiresAt,
        },
        "auth.oauth.refreshed",
      );
    })();

    this.refreshLocks.set(lockKey, promise);
    try {
      await promise;
    } finally {
      this.refreshLocks.delete(lockKey);
    }
  }
}
