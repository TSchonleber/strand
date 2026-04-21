import type Database from "better-sqlite3";

export interface RateCounter {
  windowKey: string;
  count: number;
  capacity: number;
  resetAt: number; // ms epoch
}

/**
 * SQLite-backed fixed-window counter. Windows are bucketed by
 * (scope, kind, bucketIso) so the table naturally self-cleans once
 * bucket times roll over.
 */
export class RateLimiter {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_counters (
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        bucket TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        reset_at INTEGER NOT NULL,
        PRIMARY KEY (scope, kind, bucket)
      )
    `);
  }

  private bucketOf(now: number, windowMs: number): { bucket: string; resetAt: number } {
    const resetAt = Math.ceil(now / windowMs) * windowMs;
    return { bucket: String(resetAt), resetAt };
  }

  check(args: {
    scope: string;
    kind: string;
    windowMs: number;
    capacity: number;
    now?: number;
  }): { allowed: boolean; remaining: number; resetAt: number } {
    const now = args.now ?? Date.now();
    const { bucket, resetAt } = this.bucketOf(now, args.windowMs);
    const row = this.db
      .prepare(
        "SELECT count FROM rate_counters WHERE scope = ? AND kind = ? AND bucket = ?",
      )
      .get(args.scope, args.kind, bucket) as { count: number } | undefined;
    const count = row?.count ?? 0;
    return {
      allowed: count < args.capacity,
      remaining: Math.max(0, args.capacity - count),
      resetAt,
    };
  }

  increment(args: { scope: string; kind: string; windowMs: number; now?: number }): void {
    const now = args.now ?? Date.now();
    const { bucket, resetAt } = this.bucketOf(now, args.windowMs);
    this.db
      .prepare(
        `INSERT INTO rate_counters (scope, kind, bucket, count, reset_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(scope, kind, bucket) DO UPDATE SET count = count + 1`,
      )
      .run(args.scope, args.kind, bucket, resetAt);
  }

  gc(now?: number): number {
    const t = now ?? Date.now();
    const r = this.db.prepare("DELETE FROM rate_counters WHERE reset_at < ?").run(t);
    return r.changes;
  }
}
