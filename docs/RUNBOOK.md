# Strand Runbook

Operational procedures for running Strand in Phase 1 read-only mode.

## Phase 1: 48h Sanity Check Run

### Prerequisites

- [ ] Phase 0 scaffold complete (`pnpm strand doctor` passes)
- [ ] OAuth tokens set (`pnpm keys list` shows `X_USER_ACCESS_TOKEN`)
- [ ] brainctl MCP reachable (`pnpm memory:bootstrap` succeeds)
- [ ] SQLite DB initialized (`./data/strand.db` exists)
- [ ] `STRAND_MODE=shadow` in `.env`

### Starting the 48h Run

```bash
# Ensure shadow mode (no writes to X)
export STRAND_MODE=shadow
export STRAND_HALT=false

# Start orchestrator in background
pnpm strand start &

# Record start time for 48h window
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)" > ./data/phase1-run.log
```

### Monitoring During Run

Every 4 hours, run:

```bash
# Quick status check
pnpm strand status

# Programmatic sanity check
pnpm strand status --json | jq '.event_counts, .orphan_events'
```

Expected values after 4h (Basic tier):
- `event_counts.mention`: >= 0 (depends on mentions received)
- `event_counts.dm_received`: >= 0
- `orphan_events`: 0 (all events forwarded to brainctl)

### Kill Switch (Emergency Halt)

If anything goes wrong:

```bash
# Halt all loops within 5 seconds
export STRAND_HALT=true
pnpm strand status --json | jq '.env.strand_halt'  # should be "true"

# Or kill the process entirely
pkill -SIGTERM -f "strand start"
```

### 48h Sanity Check

After 48 hours, verify:

```bash
# Get full status
pnpm strand status --json > ./data/phase1-48h-status.json

# Key assertions
cat ./data/phase1-48h-status.json | jq '
  {
    total_events: [.event_counts | to_entries[] | .value] | add,
    orphans: .orphan_events,
    duration_hours: (
      ((.event_time_range.last | fromdateiso8601) - (.event_time_range.first | fromdateiso8601)) / 3600
    ),
    halt_triggered: (.env.strand_halt == "true")
  }
'
```

**Pass criteria:**
- `total_events > 0` (something was perceived)
- `orphans == 0` (all events reached brainctl)
- `duration_hours >= 47` (ran for ~48h)
- `halt_triggered == false` (no emergency halt)
- No entries in `dlq` table (no dead-letter queue items)

### Memory Shape Verification

```bash
# Verify brainctl received events
brainctl event list --limit 50 --format json | jq 'length'

# Check entity counts
brainctl entity list --format json | jq 'length'

# Verify no orphan memories
brainctl memory search --query "orphan" --format json
```

### Rollback

If sanity check fails:

1. Halt: `export STRAND_HALT=true`
2. Snapshot DB: `cp ./data/strand.db ./data/strand.db.bak.$(date +%s)`
3. Review logs: `pnpm strand status` + Pino log output
4. File bug with: status JSON + log excerpts + DB snapshot path

## Gate to Phase 2

Before enabling Phase 2 (Reasoner in shadow):

- [ ] 48h run passed all sanity checks
- [ ] No policy-gate bypasses in `action_log`
- [ ] brainctl entity count stable (no runaway growth)
- [ ] Memory consolidation functioning (`consolidator_runs` has rows)
- [ ] Operator reviewed first 50 `perceived_events` for data quality

## Phase 2: Reasoner in shadow

In Phase 2 the Reasoner ticks every 10 min and emits ≤5 `CandidateEnvelope`s.
The Actor is a no-op in `STRAND_MODE=shadow` — all candidates are written to
`action_log` with `mode='shadow'` but nothing is posted to X.

### Daily labeling workflow

```bash
# Ensure shadow mode
export STRAND_MODE=shadow

# Walk recent unlabeled candidates and label each good/bad/unclear
pnpm strand review candidates --limit 50 --mode shadow

# Check progress toward Phase 3 gate
pnpm strand review agreement

# Programmatic gate check
pnpm strand review agreement --json | jq '.gate'
```

Labeling guidelines (operator judgment):

- **good** — action is on-persona, factually grounded, and you would approve it.
- **bad** — action is off-persona, wrong target, low-quality, or rate-cap risk.
- **unclear** — you cannot decide without more context. Excluded from agreement math.

### Prompt + threshold tuning

During Phase 2 you may:

1. Edit `prompts/reasoner.system.md` or `prompts/persona.md` and re-run.
2. Tune `persona.thresholds.relevance_min` in `persona.yaml` (restart loop to apply).
3. Adjust `policy.yaml` thresholds — re-run `pnpm strand review agreement` after each change.

Each prompt change bumps the hash logged in `reasoner_runs.usage_json`, so you
can attribute label quality to a specific prompt version.

## Gate to Phase 3

Before enabling low-risk live actions (`like` + `bookmark`):

- [ ] `pnpm strand review gate-check` exits 0 (≥100 labeled, ≥80% agreement)
- [ ] `pnpm strand review agreement --json | jq '.gate.met'` → `true`
  (confirms same criteria with full confusion matrix)
- [ ] Confusion matrix shows no systematic `false_approve` bias
  (i.e. policy approves ≤5 actions the operator would reject)
- [ ] No `reasoner.candidate_cap_enforced` warnings sustained over ≥48h
  (model consistently emits ≤5 — overrun implies prompt drift)
- [ ] Actor dry-run verified: `action_log` rows show `status='executed'` in
  shadow mode with the write path short-circuited before the X API call

## Phase 3: Low-risk actions live

In Phase 3 the Actor enables **only** `like` and `bookmark` in live mode. All
other actions (`reply`, `quote`, `post`, `follow`, `dm`) remain in shadow mode
even when `STRAND_MODE=live`.

### Phase 3 gate checklist

Before enabling live actions:

```bash
# 1. Verify gate criteria met (≥100 labeled, ≥80% agreement)
pnpm strand review gate-check

# 2. Verify half-caps configured (ramp_multiplier should be 0.5)
cat config/policies.yaml | grep ramp_multiplier  # should be 0.5

# 3. Check metrics baseline (run for 24h in shadow with metrics enabled)
pnpm strand status --metrics
```

### Enabling live mode

```bash
# 1. Confirm readiness
pnpm strand review gate-check --json | jq '.ready'  # should be true

# 2. Set live mode (only like/bookmark will actually go live)
export STRAND_MODE=live
export STRAND_HALT=false

# 3. Restart orchestrator
pkill -SIGTERM -f "strand start"
pnpm strand start &

# 4. Record transition
echo "Phase 3 live start: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ./data/phase3.log
```

### Phase 3 kill switch (drain mode)

If anything goes wrong, the kill switch implements drain semantics:

```bash
# STRAND_HALT stops the Reasoner (no new candidates)
# Perceiver continues (reads are safe)
# In-flight actions complete; new actions are rejected
export STRAND_HALT=true
```

Verify drain state:
```bash
# Check halt is active
pnpm strand status --json | jq '.env.strand_halt'  # should be "true"

# Check no new candidates being emitted (reasoner_runs should stop growing)
pnpm strand status | grep reasoner_runs
```

### Monitoring Phase 3 health

Check metrics dashboard every 4 hours:

```bash
# Full metrics dashboard
pnpm strand status --metrics

# Key metrics to watch:
# - X API health: rate limits healthy, monthly cap < 50%
# - Follower delta: no sudden negative spikes (>10% drop)
# - Error rates: < 5% failure rate on like/bookmark
```

### Cap enforcement (half-caps during ramp-up)

Phase 3 uses `ramp_multiplier: 0.5` in `policies.yaml`:

| Action | Daily Cap (full) | Phase 3 Cap (0.5x) |
|--------|------------------|-------------------|
| likes | 200 | 100 |
| bookmarks | 50 | 25 |

Verify caps in effect:
```bash
# Check action_log for cap enforcement
sqlite3 ./data/strand.db "SELECT kind, COUNT(*) FROM action_log WHERE status='executed' AND created_at > datetime('now', '-24 hours') GROUP BY kind"
```

### Rollback to shadow

If you need to revert:

```bash
# 1. Halt first (drain in-flight)
export STRAND_HALT=true
sleep 30  # wait for drain

# 2. Switch back to shadow
export STRAND_MODE=shadow
export STRAND_HALT=false

# 3. Restart
pkill -SIGTERM -f "strand start"
pnpm strand start &

# 4. Record rollback
echo "Phase 3 rollback: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ./data/phase3.log
```

### Gate to Phase 4

Before enabling `reply` live:

- [ ] Phase 3 ran clean for ≥ 72 hours
- [ ] `like` and `bookmark` error rate < 1%
- [ ] No X rate limit 429s sustained
- [ ] Follower delta stable (no negative trend)
- [ ] `pnpm strand review agreement --mode=live` shows ≥90% agreement
- [ ] Human review queue shows manageable volume
