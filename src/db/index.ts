import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "@/config";
import { log } from "@/util/log";
import Database from "better-sqlite3";

let _db: Database.Database | null = null;

/**
 * Ensure a column exists on a table. SQLite `ALTER TABLE ADD COLUMN` fails
 * if the column already exists, so we check first via PRAGMA.
 */
function ensureColumn(
  d: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = d.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    log.info({ table, column }, "db.migration.add_column");
  }
}

/**
 * Apply idempotent migrations for columns added after v1.
 * Keeps schema.sql as the source of truth for fresh DBs; this handles upgrades.
 */
function applyMigrations(d: Database.Database): void {
  // Phase 2: operator labeling columns on action_log
  ensureColumn(d, "action_log", "operator_label", "TEXT");
  ensureColumn(d, "action_log", "labeled_at", "TEXT");
  ensureColumn(d, "action_log", "label_note", "TEXT");
}

export function db(): Database.Database {
  if (_db) return _db;
  const inMemory = env.DATABASE_PATH === ":memory:";
  const dbPath = inMemory ? ":memory:" : resolve(process.cwd(), env.DATABASE_PATH);
  if (!inMemory) mkdirSync(dirname(dbPath), { recursive: true });
  const d = new Database(dbPath);
  d.pragma(inMemory ? "journal_mode = MEMORY" : "journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  const schema = readFileSync(resolve(process.cwd(), "src/db/schema.sql"), "utf8");
  d.exec(schema);
  applyMigrations(d);
  _db = d;
  log.info({ dbPath }, "db.open");
  return d;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
