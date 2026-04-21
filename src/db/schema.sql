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
CREATE INDEX IF NOT EXISTS idx_action_log_decision ON action_log(decision_id);

CREATE TABLE IF NOT EXISTS cooldowns (
  scope TEXT NOT NULL,           -- 'target:<userId>' or 'pair:<a>:<b>'
  kind TEXT NOT NULL,            -- 'any' | action kind
  until_at INTEGER NOT NULL,     -- ms epoch
  PRIMARY KEY (scope, kind)
);

CREATE INDEX IF NOT EXISTS idx_cooldowns_until ON cooldowns(until_at);

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

CREATE TABLE IF NOT EXISTS consolidator_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  status TEXT NOT NULL,  -- queued | in_progress | completed | failed | partial
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  summary_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_consolidator_runs_status ON consolidator_runs(status);

CREATE TABLE IF NOT EXISTS reasoner_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  response_id TEXT,
  previous_response_id TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT,
  cost_in_usd_ticks INTEGER,
  stuck_mid_thought INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reasoner_runs_tick ON reasoner_runs(tick_at);
CREATE INDEX IF NOT EXISTS idx_reasoner_runs_stuck ON reasoner_runs(stuck_mid_thought);

CREATE TABLE IF NOT EXISTS agent_task_graphs (
  id TEXT PRIMARY KEY,
  root_goal TEXT NOT NULL,
  status TEXT NOT NULL,        -- pending|running|completed|failed|skipped|abandoned
  metadata_json TEXT,          -- JSON object
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_task_graphs_status ON agent_task_graphs(status);

CREATE TABLE IF NOT EXISTS agent_task_steps (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL REFERENCES agent_task_graphs(id) ON DELETE CASCADE,
  parent_id TEXT,
  goal TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,     -- JSON array of tool names
  max_iterations INTEGER,
  budget_json TEXT,                      -- partial BudgetLimits
  status TEXT NOT NULL,
  result_json TEXT,                      -- JSON.stringify(result)
  error TEXT,
  reflection TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_task_steps_graph ON agent_task_steps(graph_id);
CREATE INDEX IF NOT EXISTS idx_agent_task_steps_status ON agent_task_steps(status);

CREATE TABLE IF NOT EXISTS agent_tool_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id TEXT NOT NULL REFERENCES agent_task_graphs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES agent_task_steps(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  duration_ms INTEGER,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_invocations_graph ON agent_tool_invocations(graph_id, step_id);
