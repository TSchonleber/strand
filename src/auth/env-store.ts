import type { CredentialStore } from "./credentials";

/**
 * Reads/writes `process.env`. Default store — preserves every existing
 * deployment that set keys in `.env`. Write semantics mutate the current
 * process only (not persisted to disk).
 */
export class EnvCredentialStore implements CredentialStore {
  readonly name = "env";

  async get(key: string): Promise<string | undefined> {
    const v = process.env[key];
    return v && v.length > 0 ? v : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    Object.assign(process.env, { [key]: value });
  }

  async delete(key: string): Promise<void> {
    delete process.env[key];
  }

  async list(): Promise<string[]> {
    return Object.keys(process.env).filter((k) => this.isCredentialish(k));
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    Object.assign(process.env, entries);
  }

  /** Heuristic — list() only surfaces likely-credential env vars, not PATH/HOME/etc. */
  private isCredentialish(k: string): boolean {
    return (
      k.endsWith("_API_KEY") ||
      k.endsWith("_TOKEN") ||
      k.endsWith("_SECRET") ||
      k.startsWith("X_USER_") ||
      k.startsWith("X_CLIENT_") ||
      k.startsWith("BRAINCTL_REMOTE_")
    );
  }
}
