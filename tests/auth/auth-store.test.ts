import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthEntry, AuthStoreDataSchema, CockpitAuthStore } from "@/auth/auth-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function tmpStorePath(): string {
  const dir = join(
    tmpdir(),
    `strand-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, "auth.json");
}

describe("CockpitAuthStore", () => {
  let storePath: string;
  let store: CockpitAuthStore;

  beforeEach(() => {
    storePath = tmpStorePath();
    store = new CockpitAuthStore({ path: storePath });
  });

  afterEach(() => {
    const dir = join(storePath, "..");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("read returns empty store when file does not exist", () => {
    const data = store.read();
    expect(data.active_provider).toBeNull();
    expect(data.providers).toEqual({});
    expect(data.suppressed_sources).toEqual({});
  });

  it("setActiveProvider persists and reads back", () => {
    const entry: AuthEntry = { auth_type: "api_key", source: "env:ANTHROPIC_API_KEY" };
    store.setActiveProvider("anthropic", entry);

    const data = store.read();
    expect(data.active_provider).toBe("anthropic");
    expect(data.providers["anthropic"]).toEqual(entry);
  });

  it("clearProvider removes provider and resets active if matching", () => {
    const entry: AuthEntry = { auth_type: "api_key", source: "env:XAI_API_KEY" };
    store.setActiveProvider("xai", entry);
    expect(store.activeProvider()).toBe("xai");

    store.clearProvider("xai");
    expect(store.activeProvider()).toBeNull();
    expect(store.read().providers["xai"]).toBeUndefined();
  });

  it("clearProvider does not reset active if different provider", () => {
    store.setActiveProvider("openai", { auth_type: "api_key", source: "env:OPENAI_API_KEY" });
    store.update((s) => ({
      ...s,
      providers: {
        ...s.providers,
        xai: { auth_type: "api_key" as const, source: "env:XAI_API_KEY" },
      },
    }));
    store.clearProvider("xai");
    expect(store.activeProvider()).toBe("openai");
  });

  it("suppressed sources work", () => {
    expect(store.isSuppressed("anthropic", "cli_credentials")).toBe(false);
    store.suppressSource("anthropic", "cli_credentials");
    expect(store.isSuppressed("anthropic", "cli_credentials")).toBe(true);
  });

  it("suppressSource is idempotent", () => {
    store.suppressSource("anthropic", "cli_credentials");
    store.suppressSource("anthropic", "cli_credentials");
    const data = store.read();
    expect(data.suppressed_sources["anthropic"]).toEqual(["cli_credentials"]);
  });

  it("providerAuthType returns the auth type", () => {
    store.setActiveProvider("openai", {
      auth_type: "oauth_device_code",
      tokens: { access_token: "tok" },
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    expect(store.providerAuthType("openai")).toBe("oauth_device_code");
    expect(store.providerAuthType("xai")).toBeNull();
  });

  it("validates data on read (rejects corrupt file)", () => {
    mkdirSync(join(storePath, ".."), { recursive: true });
    writeFileSync(storePath, '{"active_provider": 42}');
    expect(() => store.read()).toThrow();
  });

  it("update acquires and releases lock", () => {
    store.update((s) => s);
    const lockPath = `${storePath}.lock`;
    expect(existsSync(lockPath)).toBe(false);
  });

  it("schema validates full store shape", () => {
    const valid = {
      active_provider: "openai",
      providers: {
        openai: {
          auth_type: "oauth_device_code",
          tokens: { access_token: "at", refresh_token: "rt" },
          expires_at: "2099-01-01T00:00:00.000Z",
        },
        anthropic: { auth_type: "api_key", source: "env:ANTHROPIC_API_KEY" },
      },
      suppressed_sources: { anthropic: ["cli_credentials"] },
    };
    expect(() => AuthStoreDataSchema.parse(valid)).not.toThrow();
  });

  it("schema rejects invalid auth_type", () => {
    const invalid = {
      active_provider: "openai",
      providers: {
        openai: { auth_type: "magic", source: "nowhere" },
      },
      suppressed_sources: {},
    };
    expect(() => AuthStoreDataSchema.parse(invalid)).toThrow();
  });
});
