import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileCredentialStore } from "@/auth/encrypted-file-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("EncryptedFileCredentialStore", () => {
  let dir: string;
  let path: string;
  const passphrase = "testing-passphrase-1234";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strand-encstore-"));
    path = join(dir, "c.enc.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses to construct with a short passphrase", () => {
    expect(() => new EncryptedFileCredentialStore({ path, passphrase: "short" })).toThrow(
      /at least 8 chars/,
    );
  });

  it("set + get round-trips through the ciphertext on disk", async () => {
    const store = new EncryptedFileCredentialStore({ path, passphrase });
    await store.set("XAI_API_KEY", "sk-xai-abc123");
    await store.set("OPENAI_API_KEY", "sk-oai-xyz");
    expect(await store.get("XAI_API_KEY")).toBe("sk-xai-abc123");
    expect(await store.get("OPENAI_API_KEY")).toBe("sk-oai-xyz");

    // Raw file must NOT contain the plaintext.
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("sk-xai-abc123");
    expect(raw).not.toContain("sk-oai-xyz");
    const payload = JSON.parse(raw);
    expect(payload.version).toBe(1);
    expect(payload.kdf).toBe("scrypt");
    expect(typeof payload.ct).toBe("string");
  });

  it("re-reading from a fresh instance with the same passphrase succeeds", async () => {
    const a = new EncryptedFileCredentialStore({ path, passphrase });
    await a.setMany({ A: "1", B: "2" });

    const b = new EncryptedFileCredentialStore({ path, passphrase });
    expect(await b.get("A")).toBe("1");
    expect(await b.get("B")).toBe("2");
    const listed = await b.list();
    expect(listed.sort()).toEqual(["A", "B"]);
  });

  it("rejects decryption with the wrong passphrase", async () => {
    const a = new EncryptedFileCredentialStore({ path, passphrase });
    await a.set("X", "v");

    const b = new EncryptedFileCredentialStore({ path, passphrase: "wrong-passphrase-xx" });
    await expect(b.get("X")).rejects.toThrow(/decryption failed/);
  });

  it("delete removes the key and persists", async () => {
    const a = new EncryptedFileCredentialStore({ path, passphrase });
    await a.setMany({ X: "1", Y: "2" });
    await a.delete("X");

    const b = new EncryptedFileCredentialStore({ path, passphrase });
    expect(await b.get("X")).toBeUndefined();
    expect(await b.get("Y")).toBe("2");
  });

  it("gracefully starts fresh when the file is missing", async () => {
    const store = new EncryptedFileCredentialStore({
      path: join(dir, "does-not-exist.enc.json"),
      passphrase,
    });
    expect(await store.list()).toEqual([]);
  });
});
