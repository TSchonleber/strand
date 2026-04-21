import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "@/config";
import { log } from "@/util/log";
import Database from "better-sqlite3";

let _db: Database.Database | null = null;

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
