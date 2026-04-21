import { EnvCredentialStore, TenantScopedCredentialStore } from "@/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("TenantScopedCredentialStore", () => {
  const KEYS = [
    "tenant:acme:XAI_API_KEY",
    "tenant:acme:OPENAI_API_KEY",
    "tenant:other:XAI_API_KEY",
  ];

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("rejects invalid tenant ids", () => {
    const base = new EnvCredentialStore();
    expect(() => new TenantScopedCredentialStore(base, "has:colon")).toThrow(/invalid tenantId/);
    expect(() => new TenantScopedCredentialStore(base, "has space")).toThrow(/invalid tenantId/);
    expect(() => new TenantScopedCredentialStore(base, "")).toThrow(/invalid tenantId/);
  });

  it("accepts alnum + _ - .", () => {
    const base = new EnvCredentialStore();
    expect(() => new TenantScopedCredentialStore(base, "acme_v2")).not.toThrow();
    expect(() => new TenantScopedCredentialStore(base, "a.b-c_1")).not.toThrow();
  });

  it("writes and reads through the prefixed key", async () => {
    const base = new EnvCredentialStore();
    const acme = new TenantScopedCredentialStore(base, "acme");
    await acme.set("XAI_API_KEY", "sk-acme");

    expect(process.env["tenant:acme:XAI_API_KEY"]).toBe("sk-acme");
    expect(await acme.get("XAI_API_KEY")).toBe("sk-acme");
  });

  it("tenants are isolated", async () => {
    const base = new EnvCredentialStore();
    const acme = new TenantScopedCredentialStore(base, "acme");
    const other = new TenantScopedCredentialStore(base, "other");

    await acme.set("XAI_API_KEY", "sk-acme");
    await other.set("XAI_API_KEY", "sk-other");

    expect(await acme.get("XAI_API_KEY")).toBe("sk-acme");
    expect(await other.get("XAI_API_KEY")).toBe("sk-other");
  });

  it("list strips the prefix and only surfaces this tenant's keys", async () => {
    const base = new EnvCredentialStore();
    const acme = new TenantScopedCredentialStore(base, "acme");
    await acme.setMany({ XAI_API_KEY: "1", OPENAI_API_KEY: "2" });
    await base.set("tenant:other:XAI_API_KEY", "3");

    const listed = await acme.list();
    expect(listed.sort()).toEqual(["OPENAI_API_KEY", "XAI_API_KEY"]);
  });

  it("setMany scopes every entry", async () => {
    const base = new EnvCredentialStore();
    const acme = new TenantScopedCredentialStore(base, "acme");
    await acme.setMany({ XAI_API_KEY: "a", OPENAI_API_KEY: "b" });
    expect(process.env["tenant:acme:XAI_API_KEY"]).toBe("a");
    expect(process.env["tenant:acme:OPENAI_API_KEY"]).toBe("b");
  });

  it("delete scopes to the tenant", async () => {
    const base = new EnvCredentialStore();
    const acme = new TenantScopedCredentialStore(base, "acme");
    await acme.set("XAI_API_KEY", "v");
    await acme.delete("XAI_API_KEY");
    expect(process.env["tenant:acme:XAI_API_KEY"]).toBeUndefined();
  });
});
