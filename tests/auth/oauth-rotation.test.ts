import { OAuthCredentialStore, type OAuthProviderStrategy } from "@/auth/oauth-store";
import { describe, expect, it, vi } from "vitest";

/**
 * OAuth token rotation safety tests.
 *
 * X OAuth refresh tokens rotate on every use. If we crash mid-write or have a
 * race between concurrent refreshes, we could lose the new refresh token and
 * lock ourselves out. These tests verify atomic persistence.
 */

describe("OAuthCredentialStore rotation safety", () => {
  it("updates all tokens atomically via setMany", async () => {
    const setManyCalls: Array<Record<string, string>> = [];

    // Mock base store that captures setMany calls
    const mockBase = {
      name: "mock",
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      setMany: vi.fn(async (entries: Record<string, string>) => {
        setManyCalls.push({ ...entries });
      }),
    };

    const store = new OAuthCredentialStore(mockBase);

    const strategy: OAuthProviderStrategy = {
      name: "x",
      accessTokenKey: "X_USER_ACCESS_TOKEN",
      refreshTokenKey: "X_USER_REFRESH_TOKEN",
      expiresAtKey: "X_USER_TOKEN_EXPIRES_AT",
      refreshWindowSeconds: 60,
      refresh: vi.fn().mockResolvedValue({
        accessToken: "new_access_123",
        refreshToken: "new_refresh_456", // rotated!
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }),
    };

    store.registerStrategy(strategy);

    // Prime the base store with an expired token
    mockBase.get = vi.fn(async (key: string) => {
      if (key === "X_USER_ACCESS_TOKEN") return "old_access";
      if (key === "X_USER_REFRESH_TOKEN") return "old_refresh";
      if (key === "X_USER_TOKEN_EXPIRES_AT") return new Date(Date.now() - 1000).toISOString();
      return undefined;
    });

    // Trigger refresh via get()
    await store.get("X_USER_ACCESS_TOKEN");

    // Should have called setMany exactly once with all three keys
    expect(setManyCalls.length).toBe(1);
    expect(setManyCalls[0]).toHaveProperty("X_USER_ACCESS_TOKEN", "new_access_123");
    expect(setManyCalls[0]).toHaveProperty("X_USER_REFRESH_TOKEN", "new_refresh_456");
    expect(setManyCalls[0]).toHaveProperty("X_USER_TOKEN_EXPIRES_AT");

    // No partial updates via individual set()
    expect(mockBase.set).not.toHaveBeenCalled();
  });

  it("prevents concurrent refresh with promise lock", async () => {
    const refreshCalls: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let resolveFirstRefresh: () => void = () => {};

    // Track stored values
    const storeData: Record<string, string> = {
      X_USER_ACCESS_TOKEN: "access",
      X_USER_REFRESH_TOKEN: "refresh",
      X_USER_TOKEN_EXPIRES_AT: new Date(Date.now() - 1000).toISOString(),
    };

    const mockBase = {
      name: "mock",
      get: vi.fn(async (key: string) => storeData[key]),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      setMany: vi.fn(async (entries: Record<string, string>) => {
        Object.assign(storeData, entries);
      }),
    };

    const store = new OAuthCredentialStore(mockBase);

    let refreshCount = 0;
    const strategy: OAuthProviderStrategy = {
      name: "x",
      accessTokenKey: "X_USER_ACCESS_TOKEN",
      refreshTokenKey: "X_USER_REFRESH_TOKEN",
      expiresAtKey: "X_USER_TOKEN_EXPIRES_AT",
      refresh: vi.fn(async () => {
        refreshCount++;
        refreshCalls.push(refreshCount);
        // Block first refresh until we manually resolve
        if (refreshCount === 1) {
          await new Promise<void>((r) => {
            resolveFirstRefresh = r as () => void;
          });
        }
        return {
          accessToken: `access_v${refreshCount}`,
          refreshToken: `refresh_v${refreshCount}`,
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        };
      }),
    };

    store.registerStrategy(strategy);

    // Fire two concurrent gets
    const p1 = store.get("X_USER_ACCESS_TOKEN");
    const p2 = store.get("X_USER_ACCESS_TOKEN");

    // Let async work start
    await new Promise((r) => setTimeout(r, 10));

    // Both should be in-flight, but refresh should only happen once
    expect(refreshCount).toBe(1);

    // Resolve the first refresh
    if (resolveFirstRefresh) resolveFirstRefresh();

    // Wait for both to complete
    const [r1, r2] = await Promise.all([p1, p2]);

    // Both gets should return the same refreshed token
    expect(r1).toBe("access_v1");
    expect(r2).toBe("access_v1");

    // Refresh should have only been called once (concurrency protection)
    expect(refreshCount).toBe(1);

    // setMany should have been called once
    expect(mockBase.setMany).toHaveBeenCalledTimes(1);
  });

  it("handles non-rotating refresh tokens (same token returned)", async () => {
    const setManyCalls: Array<Record<string, string>> = [];

    const mockBase = {
      name: "mock",
      get: vi.fn(async (key: string) => {
        if (key === "X_USER_ACCESS_TOKEN") return "access";
        if (key === "X_USER_REFRESH_TOKEN") return "same_refresh";
        if (key === "X_USER_TOKEN_EXPIRES_AT") return new Date(Date.now() - 1000).toISOString();
        return undefined;
      }),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      setMany: vi.fn(async (entries: Record<string, string>) => {
        setManyCalls.push({ ...entries });
      }),
    };

    const store = new OAuthCredentialStore(mockBase);

    const strategy: OAuthProviderStrategy = {
      name: "x",
      accessTokenKey: "X_USER_ACCESS_TOKEN",
      refreshTokenKey: "X_USER_REFRESH_TOKEN",
      expiresAtKey: "X_USER_TOKEN_EXPIRES_AT",
      refresh: vi.fn().mockResolvedValue({
        accessToken: "new_access",
        // No refreshToken returned — provider doesn't rotate
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }),
    };

    store.registerStrategy(strategy);
    await store.get("X_USER_ACCESS_TOKEN");

    // setMany should only have access + expires (no refresh token)
    expect(setManyCalls[0]).toHaveProperty("X_USER_ACCESS_TOKEN");
    expect(setManyCalls[0]).toHaveProperty("X_USER_TOKEN_EXPIRES_AT");
    expect(setManyCalls[0]).not.toHaveProperty("X_USER_REFRESH_TOKEN");
  });
});
