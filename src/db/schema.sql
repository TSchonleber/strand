-- Strand local SQLite schema. brainctl owns the semantic layer;
-- this DB is for ops: audit log, idempotency, rate counters, DLQ.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE NOT NULL,
  decision_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  rationale TEXT,
  confidence REAL,
  relevance REAL,
  target_entity_id TEXT,
  mode TEXT NOT NULL,            -- shadow | gated | live
  status TEXT NOT NULL,          -- proposed | approved | rejected | executed | failed | reverted
  reasons_json TEXT,             -- policy reasons when rejected
  x_object_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  executed_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_action_log_status ON action_log(status);
CREATE INDEX IF NOT EXISTS idx_action_log_kind ON action_log(kind);
CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(created_at);
CREATE INDEX IF NOT EXISTS idx_action_log_target ON action_log(target_entity_id);

CREATE TABLE IF NOT EXISTS cooldowns (
  scope TEXT NOT NULL,           -- 'target:<userId>' or 'pair:<a>:<b>'
  kind TEXT NOT NULL,            -- 'any' | action kind
  until_at INTEGER NOT NULL,     -- ms epoch
  PRIMARY KEY (scope, kind)
);

CREATE TABLE IF NOT EXISTS human_review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT UNIQUE NOT NULL,
  payload_json TEXT NOT NULL,
  reasons_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  decision TEXT                  -- approved | rejected | expired
);

CREATE INDEX IF NOT EXISTS idx_review_open ON human_review_queue(decided_at) WHERE decided_at IS NULL;

CREATE TABLE IF NOT EXISTS post_embeddings (
  tweet_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  embedding_json TEXT,           -- JSON array; swap for a vector store at scale
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_post_embeddings_recent ON post_embeddings(created_at);

CREATE TABLE IF NOT EXISTS perceived_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  forwarded_to_brain INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_events_kind ON perceived_events(kind);
CREATE INDEX IF NOT EXISTS idx_events_forwarded ON perceived_events(forwarded_to_brain);

CREATE TABLE IF NOT EXISTS dlq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Existing rate_counters table is created by RateLimiter at boot.
