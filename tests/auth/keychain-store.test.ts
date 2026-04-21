import { KeychainCredentialStore } from "@/auth";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * KeychainCredentialStore tests — we inject a fake `Entry` class so these run
 * on CI without touching the real OS keychain and without installing
 * `@napi-rs/keyring`. The store's contract says "talk to an Entry factory";
 * we verify the contract in isolation.
 */

class FakeEntry {
  private static storage = new Map<string, string>();
  private readonly k: string;
  constructor(service: string, account: string) {
    this.k = `${service}:${account}`;
  }
  getPassword(): string | null {
    return FakeEntry.storage.get(this.k) ?? null;
  }
  setPassword(password: string): void {
    FakeEntry.storage.set(this.k, password);
  }
  deletePassword(): boolean {
    return FakeEntry.storage.delete(this.k);
  }
  static clear(): void {
    FakeEntry.storage.clear();
  }
}

describe("KeychainCredentialStore", () => {
  beforeEach(() => FakeEntry.clear());

  it("round-trips a set + get", async () => {
    const store = new KeychainCredentialStore({ service: "strand-test", entryClass: FakeEntry });
    await store.set("XAI_API_KEY", "sk-abc");
    expect(await store.get("XAI_API_KEY")).toBe("sk-abc");
  });

  it("get returns undefined for unset keys", async () => {
    const store = new KeychainCredentialStore({ service: "strand-test", entryClass: FakeEntry });
    expect(await store.get("NOPE")).toBeUndefined();
  });

  it("list surfaces the keys written through setMany", async () => {
    const store = new KeychainCredentialStore({ service: "strand-test", entryClass: FakeEntry });
    await store.setMany({ A: "1", B: "2", C: "3" });
    const listed = await store.list();
    expect(listed.sort()).toEqual(["A", "B", "C"]);
  });

  it("delete removes the key and the index entry", async () => {
    const store = new KeychainCredentialStore({ service: "strand-test", entryClass: FakeEntry });
    await store.setMany({ A: "1", B: "2" });
    await store.delete("A");
    expect(await store.get("A")).toBeUndefined();
    expect((await store.list()).sort()).toEqual(["B"]);
  });

  it("persists the index across fresh instances (simulated by reading the fake storage)", async () => {
    const a = new KeychainCredentialStore({ service: "svc-persistent", entryClass: FakeEntry });
    await a.setMany({ X: "1" });

    const b = new KeychainCredentialStore({ service: "svc-persistent", entryClass: FakeEntry });
    expect(await b.get("X")).toBe("1");
    expect((await b.list()).sort()).toEqual(["X"]);
  });

  it("isolates services (two stores under different services don't see each other's keys)", async () => {
    const a = new KeychainCredentialStore({ service: "svc-a", entryClass: FakeEntry });
    const b = new KeychainCredentialStore({ service: "svc-b", entryClass: FakeEntry });
    await a.set("K", "a-val");
    await b.set("K", "b-val");
    expect(await a.get("K")).toBe("a-val");
    expect(await b.get("K")).toBe("b-val");
  });
});
