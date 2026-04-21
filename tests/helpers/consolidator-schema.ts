import type Database from "better-sqlite3";

/**
 * Adds the consolidator_runs table. Subagent D owns the DDL in schema.sql;
 * this helper lets Subagent B's tests run in isolation before D's branch
 * merges. Keep the column set in lockstep with D's schema.
 */
export function ensureConsolidatorRunsTable(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS consolidator_runs (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      status TEXT,
      created_at TEXT,
      completed_at TEXT,
      summary_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_consolidator_runs_status ON consolidator_runs(status);
  `);
}
