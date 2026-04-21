import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

/**
 * Build an in-memory SQLite DB pre-loaded with the project schema.
 * Each test gets its own isolated instance — no file I/O, no shared state.
 */
export function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("journal_mode = MEMORY");
  d.pragma("foreign_keys = ON");
  const schema = readFileSync(resolve(process.cwd(), "src/db/schema.sql"), "utf8");
  d.exec(schema);
  d.exec(`
    CREATE TABLE IF NOT EXISTS rate_counters (
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL,
      PRIMARY KEY (scope, kind, bucket)
    )
  `);
  return d;
}
