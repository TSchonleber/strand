import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "@/util/log";
import type { CredentialStore } from "./credentials";

/**
 * JSON file credential store.
 *
 * Default path: `~/.strand/credentials.json`, mode 0600.
 * Layout: flat `{ [key]: value }` object.
 *
 * Writes go through a tempfile + atomic `rename()` so a crash mid-write can't
 * leave half-written credentials. Not encrypted at rest — rely on filesystem
 * permissions for now; encryption backend is a follow-up (libsodium secretbox
 * + passphrase-derived key).
 */
export class FileCredentialStore implements CredentialStore {
  readonly name = "file";
  private readonly path: string;
  private cache: Record<string, string> | null = null;

  constructor(opts?: { path?: string }) {
    this.path = opts?.path ?? defaultPath();
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
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.cache = parsed as Record<string, string>;
      } else {
        this.cache = {};
      }
    } catch (err) {
      // ENOENT / malformed — start clean.
      log.debug({ svc: "auth", store: this.name, err }, "auth.file_store.read_failed");
      this.cache = {};
    }
    return this.cache;
  }

  private write(store: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best effort — on Windows chmod is a no-op
    }
    this.cache = store;
  }
}

function defaultPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".strand");
  return join(base, xdg ? "strand" : "", "credentials.json").replace(/\/+/g, "/");
}
