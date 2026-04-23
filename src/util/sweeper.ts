import { log } from "@/util/log";
import type Database from "better-sqlite3";

/**
 * Sweep expired rows from TTL-based tables.
 * Called periodically by the orchestrator (hourly recommended).
 */
export function sweepExpired(db: Database.Database): void {
  const now = new Date().toISOString();

  // tweet_dedup: 72h TTL
  const dedup = db.prepare("DELETE FROM tweet_dedup WHERE expires_at < ?").run(now);
  if (dedup.changes > 0) {
    log.info({ count: dedup.changes, table: "tweet_dedup" }, "sweeper.cleaned");
  }

  // cooldowns: ms-epoch based
  const nowMs = Date.now();
  const cooldowns = db.prepare("DELETE FROM cooldowns WHERE until_at < ?").run(nowMs);
  if (cooldowns.changes > 0) {
    log.info({ count: cooldowns.changes, table: "cooldowns" }, "sweeper.cleaned");
  }
}

/**
 * Record a tweet hash for deduplication. 72h TTL.
 */
export function recordTweetHash(db: Database.Database, hash: string, textPreview: string): void {
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO tweet_dedup (hash, text_preview, expires_at) VALUES (?, ?, ?)",
  ).run(hash, textPreview.slice(0, 100), expiresAt);
}

/**
 * Check if a tweet hash exists (duplicate).
 */
export function isDuplicateTweet(db: Database.Database, hash: string): boolean {
  const row = db.prepare("SELECT 1 FROM tweet_dedup WHERE hash = ?").get(hash);
  return row !== undefined;
}
