import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "@/util/log";
import type { CredentialStore } from "./credentials";

/**
 * Encrypted-at-rest file credential store.
 *
 * AES-256-GCM with a scrypt-derived key. No external deps — Node's `crypto`
 * module only. File layout (JSON):
 *
 *   {
 *     "version": 1,
 *     "kdf": "scrypt",
 *     "salt": "<base64-16>",
 *     "iv":   "<base64-12>",
 *     "tag":  "<base64-16>",
 *     "ct":   "<base64 of encrypt(JSON({key:value,...}))>"
 *   }
 *
 * Passphrase resolution (in order):
 *   1. constructor opts.passphrase
 *   2. env `STRAND_CREDENTIAL_PASSPHRASE`
 *   3. refuse to boot — better than silently using a weak/default key.
 *
 * Rotating the passphrase: read with the old phrase, re-initialize with the
 * new phrase, `setMany(existing)`. A dedicated `rotatePassphrase()` helper is
 * a Phase 1.8.1 follow-up.
 *
 * Threat model: protects against casual file-system inspection + disk
 * forensics. Does NOT protect against malware running as the Strand user
 * (the same user can read the passphrase from env or prompt). For that,
 * use `KeychainCredentialStore`.
 */

const SALT_LEN = 16;
const IV_LEN = 12; // GCM standard
const KEY_LEN = 32; // AES-256
const SCRYPT_N = 16384; // ~64 MB memory, ~50 ms on a modern laptop
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const VERSION = 1;

interface FilePayload {
  version: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export class EncryptedFileCredentialStore implements CredentialStore {
  readonly name = "encrypted-file";
  private readonly path: string;
  private readonly passphrase: string;
  private cache: Record<string, string> | null = null;
  private cachedSalt: Buffer | null = null;
  private cachedKey: Buffer | null = null;

  constructor(opts?: { path?: string; passphrase?: string }) {
    this.path = opts?.path ?? defaultPath();
    const phrase = opts?.passphrase ?? process.env["STRAND_CREDENTIAL_PASSPHRASE"];
    if (!phrase || phrase.length < 8) {
      throw new Error(
        "EncryptedFileCredentialStore requires a passphrase of at least 8 chars. " +
          "Set STRAND_CREDENTIAL_PASSPHRASE or pass `passphrase` to the constructor.",
      );
    }
    this.passphrase = phrase;
  }

  async get(key: string): Promise<string | undefined> {
    const store = this.read();
    const v = store[key];
    return v && v.length > 0 ? v : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const store = this.read();
    store[key] = value;
    this.write(store);
  }

  async delete(key: string): Promise<void> {
    const store = this.read();
    if (!(key in store)) return;
    delete store[key];
    this.write(store);
  }

  async list(): Promise<string[]> {
    return Object.keys(this.read());
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    const store = this.read();
    Object.assign(store, entries);
    this.write(store);
  }

  private read(): Record<string, string> {
    if (this.cache !== null) return this.cache;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      log.debug(
        { svc: "auth", store: this.name, err },
        "auth.encrypted_file.missing_starting_clean",
      );
      this.cache = {};
      return this.cache;
    }
    const payload = JSON.parse(raw) as FilePayload;
    if (payload.version !== VERSION || payload.kdf !== "scrypt") {
      throw new Error(
        `EncryptedFileCredentialStore: unsupported payload version/kdf in ${this.path}`,
      );
    }
    const salt = Buffer.from(payload.salt, "base64");
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ct = Buffer.from(payload.ct, "base64");
    const key = this.deriveKey(salt);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (err) {
      throw new Error(
        `EncryptedFileCredentialStore: decryption failed — wrong passphrase or corrupt file (${(err as Error).message})`,
      );
    }
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      this.cache = parsed as Record<string, string>;
    } else {
      this.cache = {};
    }
    return this.cache;
  }

  private write(store: Record<string, string>): void {
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const key = this.deriveKey(salt);
    const plaintext = Buffer.from(JSON.stringify(store), "utf8");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload: FilePayload = {
      version: VERSION,
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
    };

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows / exotic FSes — best effort
    }
    this.cache = store;
  }

  private deriveKey(salt: Buffer): Buffer {
    // Reuse the derived key when the salt matches. scrypt is ~50 ms per call.
    if (this.cachedSalt && this.cachedKey && Buffer.compare(this.cachedSalt, salt) === 0) {
      return this.cachedKey;
    }
    const key = scryptSync(this.passphrase, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 128 * 1024 * 1024,
    });
    this.cachedSalt = Buffer.from(salt);
    this.cachedKey = key;
    return key;
  }
}

function defaultPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? join(xdg, "strand") : join(homedir(), ".strand");
  return join(base, "credentials.enc.json");
}
