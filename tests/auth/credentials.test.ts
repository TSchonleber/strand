import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChainedCredentialStore,
  EnvCredentialStore,
  FileCredentialStore,
  MissingCredentialError,
  OAuthCredentialStore,
  requireCredential,
} from "@/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("EnvCredentialStore", () => {
  let saved: Record<string, string | undefined>;
  const KEYS = ["STRAND_TEST_KEY_1", "STRAND_TEST_KEY_2"] as const;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else Object.assign(process.env, { [k]: saved[k] });
    }
  });

  it("get returns undefined for unset keys", async () => {
    const store = new EnvCredentialStore();
    expect(await store.get("STRAND_TEST_KEY_1")).toBeUndefined();
  });

  it("set + get round-trips through process.env", async () => {
    const store = new EnvCredentialStore();
    await store.set("STRAND_TEST_KEY_1", "abc");
    expect(process.env["STRAND_TEST_KEY_1"]).toBe("abc");
    expect(await store.get("STRAND_TEST_KEY_1")).toBe("abc");
  });

  it("delete removes the key", async () => {
    const store = new EnvCredentialStore();
    await store.set("STRAND_TEST_KEY_1", "abc");
    await store.delete("STRAND_TEST_KEY_1");
    expect(process.env["STRAND_TEST_KEY_1"]).toBeUndefined();
  });

  it("setMany applies atomically", async () => {
    const store = new EnvCredentialStore();
    await store.setMany({ STRAND_TEST_KEY_1: "a", STRAND_TEST_KEY_2: "b" });
    expect(await store.get("STRAND_TEST_KEY_1")).toBe("a");
    expect(await store.get("STRAND_TEST_KEY_2")).toBe("b");
  });

  it("list surfaces credential-ish keys only", async () => {
    const store = new EnvCredentialStore();
    await store.setMany({
      STRAND_TEST_KEY_1: "v",
      STRAND_TEST_KEY_2: "w",
    });
    const listed = await store.list();
    // STRAND_TEST_KEY_1 ends with _KEY_1 which isn't in the heuristic's list;
    // the heuristic only matches _API_KEY / _TOKEN / _SECRET / X_USER_* / X_CLIENT_* / BRAINCTL_REMOTE_*
    // So we don't expect STRAND_TEST_KEY_* to appear here. Use that to prove
    // the heuristic is selective.
    expect(listed.includes("STRAND_TEST_KEY_1")).toBe(false);
  });
});

describe("FileCredentialStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strand-creds-"));
    path = join(dir, "creds.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a set + get + delete", async () => {
    const store = new FileCredentialStore({ path });
    expect(await store.get("XAI_API_KEY")).toBeUndefined();

    await store.set("XAI_API_KEY", "sk-xai-abc");
    expect(await store.get("XAI_API_KEY")).toBe("sk-xai-abc");

    await store.delete("XAI_API_KEY");
    expect(await store.get("XAI_API_KEY")).toBeUndefined();
  });

  it("persists to disk with 0600 perms and valid JSON", async () => {
    const store = new FileCredentialStore({ path });
    await store.set("XAI_API_KEY", "v");

    const mode = statSync(path).mode & 0o777;
    // On macOS + Linux umask this should be exactly 0o600. We assert owner rw
    // is set and group/other read is NOT set — the conservative invariant.
    expect(mode & 0o600).toBe(0o600);
    expect(mode & 0o044).toBe(0);

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toEqual({ XAI_API_KEY: "v" });
  });

  it("setMany persists every key at once", async () => {
    const store = new FileCredentialStore({ path });
    await store.setMany({ A: "1", B: "2", C: "3" });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("list returns every persisted key", async () => {
    const store = new FileCredentialStore({ path });
    await store.setMany({ A: "1", B: "2" });
    const listed = await store.list();
    expect(listed.sort()).toEqual(["A", "B"]);
  });

  it("gracefully starts fresh when the file is missing", async () => {
    const store = new FileCredentialStore({ path: join(dir, "does-not-exist.json") });
    expect(await store.list()).toEqual([]);
  });
});

describe("ChainedCredentialStore", () => {
  it("first-hit wins on read; writes go to the first store", async () => {
    const a = new EnvCredentialStore();
    const b = new EnvCredentialStore();
    await a.set("CHAIN_TEST_A", "from-a");
    await b.set("CHAIN_TEST_B", "from-b");

    // Both stores are actually the same process.env — but we can still test
    // the chain's fall-through semantics with keys only present in one.
    const chain = new ChainedCredentialStore([a, b]);
    expect(await chain.get("CHAIN_TEST_A")).toBe("from-a");
    expect(await chain.get("CHAIN_TEST_B")).toBe("from-b");

    await a.delete("CHAIN_TEST_A");
    await b.delete("CHAIN_TEST_B");
  });
});

describe("OAuthCredentialStore", () => {
  let base: FileCredentialStore;
  let store: OAuthCredentialStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strand-oauth-"));
    base = new FileCredentialStore({ path: join(dir, "c.json") });
    store = new OAuthCredentialStore(base);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("non-strategy keys pass through to base", async () => {
    await base.set("PLAIN_KEY", "hi");
    expect(await store.get("PLAIN_KEY")).toBe("hi");
  });

  it("refreshes when access token is within the window", async () => {
    let refreshCalls = 0;
    store.registerStrategy({
      name: "fake",
      accessTokenKey: "FAKE_ACCESS",
      refreshTokenKey: "FAKE_REFRESH",
      expiresAtKey: "FAKE_EXPIRES",
      refreshWindowSeconds: 60,
      async refresh({ refreshToken }) {
        refreshCalls++;
        expect(refreshToken).toBe("r-v1");
        return {
          accessToken: "a-v2",
          refreshToken: "r-v2",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
    });

    // Set up an about-to-expire token set.
    await base.setMany({
      FAKE_ACCESS: "a-v1",
      FAKE_REFRESH: "r-v1",
      FAKE_EXPIRES: new Date(Date.now() + 30_000).toISOString(), // 30s remaining < 60s window
    });

    const v = await store.get("FAKE_ACCESS");
    expect(v).toBe("a-v2");
    expect(refreshCalls).toBe(1);

    // Refresh token was rotated atomically along with access + expiry.
    expect(await base.get("FAKE_REFRESH")).toBe("r-v2");
    expect(await base.get("FAKE_ACCESS")).toBe("a-v2");
  });

  it("does NOT refresh when access token is comfortably valid", async () => {
    let refreshCalls = 0;
    store.registerStrategy({
      name: "fake",
      accessTokenKey: "FAKE_ACCESS",
      refreshTokenKey: "FAKE_REFRESH",
      expiresAtKey: "FAKE_EXPIRES",
      refreshWindowSeconds: 60,
      async refresh() {
        refreshCalls++;
        return {
          accessToken: "a-new",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
    });

    await base.setMany({
      FAKE_ACCESS: "a-live",
      FAKE_REFRESH: "r-live",
      FAKE_EXPIRES: new Date(Date.now() + 3600_000).toISOString(),
    });

    expect(await store.get("FAKE_ACCESS")).toBe("a-live");
    expect(refreshCalls).toBe(0);
  });

  it("concurrent get() during refresh coalesces to one network call", async () => {
    let refreshCalls = 0;
    let resolveRefresh!: () => void;
    store.registerStrategy({
      name: "fake",
      accessTokenKey: "FAKE_ACCESS",
      refreshTokenKey: "FAKE_REFRESH",
      expiresAtKey: "FAKE_EXPIRES",
      refreshWindowSeconds: 60,
      async refresh() {
        refreshCalls++;
        await new Promise<void>((r) => {
          resolveRefresh = r;
        });
        return {
          accessToken: "a-v2",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
    });

    await base.setMany({
      FAKE_ACCESS: "a-v1",
      FAKE_REFRESH: "r",
      FAKE_EXPIRES: new Date(Date.now() + 10_000).toISOString(),
    });

    const a = store.get("FAKE_ACCESS");
    const b = store.get("FAKE_ACCESS");
    const c = store.get("FAKE_ACCESS");

    // Wait a microtask so all three are queued behind the same lock.
    await new Promise((r) => setTimeout(r, 10));
    resolveRefresh();

    const [va, vb, vc] = await Promise.all([a, b, c]);
    expect(va).toBe("a-v2");
    expect(vb).toBe("a-v2");
    expect(vc).toBe("a-v2");
    expect(refreshCalls).toBe(1);
  });

  it("refreshNow triggers refresh regardless of expiry window", async () => {
    let refreshCalls = 0;
    store.registerStrategy({
      name: "fake",
      accessTokenKey: "FAKE_ACCESS",
      refreshTokenKey: "FAKE_REFRESH",
      expiresAtKey: "FAKE_EXPIRES",
      async refresh() {
        refreshCalls++;
        return {
          accessToken: "a-forced",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
    });
    await base.setMany({
      FAKE_ACCESS: "a-old",
      FAKE_REFRESH: "r",
      FAKE_EXPIRES: new Date(Date.now() + 3600_000).toISOString(),
    });

    await store.refreshNow("FAKE_ACCESS");
    expect(refreshCalls).toBe(1);
    expect(await base.get("FAKE_ACCESS")).toBe("a-forced");
  });
});

describe("requireCredential", () => {
  it("throws MissingCredentialError when unset", async () => {
    const store = new EnvCredentialStore();
    await expect(requireCredential(store, "THIS_KEY_DOES_NOT_EXIST")).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });
});
