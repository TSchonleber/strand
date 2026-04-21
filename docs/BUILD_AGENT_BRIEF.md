# Strand — Build Agent Brief

For a Claude Code agent to pick up and finish Phase 0–Phase 2. Read `CLAUDE.md`, `docs/PLAN.md`, and `/Users/r4vager/Library/.../memory/strand_api_facts.md` before starting. Those are ground truth; this file is the execution plan.

## Prime directives

- **Do not re-architect.** Four loops + policy gate + clients are fixed. Adding an action kind = variant + policy rule + client method + tests. No shortcuts.
- **Never call X, Grok, or brainctl SDKs from outside `src/clients/`.** All call sites go through the typed wrappers.
- **Every write to X passes through the policy gate.** No back door.
- **Prompts are files in `prompts/`,** not string literals. Hash at load, log hash on every Grok call.
- **Reasoning models reject** `presence_penalty`, `frequency_penalty`, `stop`, `reasoning_effort`. Strip in client by model class.
- **Set `prompt_cache_key` on every Grok call.** Pattern: `strand:<loop>:<promptHash[0..8]>`.
- **Conventional commits. Small PRs.** No "wip" on main.
- **Lead with action.** Don't return five-option menus — pick the right call, execute, note what you did in one line.

## Phase 0 — Bootstrap (single agent, sequential, ~20 min)

**Goal:** Repo is installable, typechecks clean, lints clean, tests pass, perceiver runs one cycle against a mocked X client.

Steps:
1. `cd /Users/r4vager/Documents/BrainCTL/Strand && git init && git add -A && git commit -m "chore: initial scaffold"`
2. `pnpm install` (if pnpm missing: `corepack enable && corepack prepare pnpm@latest --activate`)
3. `pnpm typecheck` — must be 0 errors. Fix any import path or type breakages introduced by the 2026-04-20 rewrite.
4. `pnpm biome check .` — fix lint. If biome flags intentional patterns (e.g. `any` at SDK boundary in `grok.ts`), keep the existing ignore comment.
5. `pnpm test` — must be all green. If a fixture references an outdated action variant, update the fixture.
6. Run `pnpm dev` with `STRAND_MODE=shadow` and mocked env. Kill after one perceiver tick.
7. Commit: `feat: phase 0 bootstrap passing`.

**Kill switch:** if any of typecheck / lint / test fail after 3 fix attempts, stop and surface the blocker. Do not paper over with `// @ts-ignore` or skipped tests.

**Metrics:** 0 tsc errors, 0 biome errors, 100% of existing tests pass, perceiver tick logs at least one `perceiver.mention_fetched` event.

## Phase 1 — Parallel build (4 subagents concurrent, ~2-3h)

Spawn **all four subagents in a single message** with independent worktrees (`isolation: "worktree"`). They don't share files. Each returns a branch + diff for merge.

### Subagent A — Reasoner completion

**Scope:** `src/loops/reasoner.ts`, `prompts/reasoner.system.md`, `tests/loops/reasoner.test.ts`

Current state: loop exists but `CANDIDATE_BATCH_SCHEMA` uses `maxItems` / `maxLength` which xAI rejects. Also missing: `promptCacheKey`, `maxTurns: 5`, `include: ["mcp_call_output", "reasoning.encrypted_content", "x_search_call.action.sources"]`, `previousResponseId` chaining for long chains.

Tasks:
1. Rewrite `CANDIDATE_BATCH_SCHEMA` to remove `maxItems`/`maxLength` — enforce in Zod post-parse only (already done in `CandidateEnvelopeSchema`; drop the JSON-schema constraints).
2. Use `anyOf` + literal `kind` for the nested `action` discriminated union in the JSON schema so Grok emits valid structures directly (not an opaque `type: "object"`). Mirror the Zod union variants.
3. Pass `promptCacheKey: "strand:reasoner:v1"`, `maxTurns: 5`, `include: [...]` to `grokCall`.
4. Persist `response.id` to `perceived_events` or a new `reasoner_runs` table so long chains can resume via `previous_response_id` on the next tick if `candidates.length === 0 && toolCalls.length > 0` (stuck mid-thought).
5. Flesh out `prompts/reasoner.system.md`: persona-aware, schema-aware, includes explicit "use brainctl memory before proposing reply/DM", "prefer `like` or `bookmark` when relevance < 0.8", "emit empty `candidates` array if nothing warrants action — do NOT invent".
6. Tests: MSW fixture for xAI Responses endpoint returning a valid CandidateBatch, a malformed one (expect warn + skip), a tool-call-only turn (expect retry with `previous_response_id`).

**Kill switch:** if Grok returns schema-validation errors from xAI in staging, Subagent A must fix the schema, not work around it with free-form parsing.

**Metrics:** reasoner.test.ts ≥ 5 test cases passing; one integration test that mocks X search + MCP calls and confirms a reply candidate is emitted.

### Subagent B — Consolidator + Batch API

**Scope:** `src/clients/grok.ts` (Batch helpers), `src/loops/consolidator.ts`, `prompts/consolidator.system.md`, `tests/loops/consolidator.test.ts`

Current state: `grokBatchCreate` / `grokBatchGet` throw. `consolidatorRun` runs a synchronous `/v1/responses` call instead of submitting to Batch.

Tasks:
1. Implement in `grok.ts`:
   - `grokFilesUpload(jsonl: string, purpose: "batch"): Promise<{ id: string }>` — `POST /v1/files` multipart.
   - `grokBatchCreate({ inputFileId, endpoint: "/v1/responses", completionWindow: "24h" }): Promise<Batch>` — `POST /v1/batches`.
   - `grokBatchGet(id): Promise<Batch>` — `GET /v1/batches/:id`.
   - `grokBatchResults(id): Promise<AsyncIterable<BatchLine>>` — stream `/v1/batches/:id/results`.
   - Type-safe Batch / BatchLine interfaces. Match xAI shape (`output_file_id`, `error_file_id`, `request_counts`, `status`).
2. Rewrite `consolidatorRun` to:
   - Build a JSONL with a handful of consolidation tasks (dream_cycle, consolidation_run, gaps_scan, retirement_analysis, reflexion_write). Each line is a separate Responses call with brainctl MCP + the consolidator prompt.
   - Upload → create batch → store `batch_id` in SQLite `consolidator_runs` table (new — add to schema.sql).
   - Return immediately. A separate `consolidatorPoll` tick (every 10min) checks status, when `completed` downloads results and logs a summary. On `failed`, alert.
3. `prompts/consolidator.system.md`: explicit instruction to produce a compact JSON summary `{ changed: [], insights: [], gaps: [], retirements: [] }`. Uses `CONSOLIDATOR_MCP_ALLOWLIST` read+write tools.
4. Tests: MSW fixtures for `/v1/files`, `/v1/batches`, `/v1/batches/:id`. One happy path, one `failed` path (expect alert), one partial (some lines errored — expect warn + still record successes).

**Kill switch:** do NOT fall back to synchronous `/v1/responses` for consolidator. 50% cost savings depends on batch path. If Batch API is down, halt and alert.

**Metrics:** consolidator can be invoked, batch lands in SQLite, poll tick transitions the row through `queued → in_progress → completed`, results rows materialize in brainctl.

### Subagent C — Composers + Prefilter classifier

**Scope:** `src/clients/grok.ts` (composer helper), `prompts/composer-post.system.md`, `prompts/composer-reply.system.md`, `prompts/composer-quote.system.md`, `prompts/composer-dm.system.md`, `src/util/prefilter.ts`, `tests/util/prefilter.test.ts`, `tests/clients/composer.test.ts`

Current state: composer prompts are stubs. Prefilter has only regex banlist. No composer wrapper — Reasoner emits text directly, which conflates reasoning and composition.

Tasks:
1. Add `grokCompose({ kind, contextJson, personaHash, policiesHash })` in `grok.ts` — uses `grok-4-1-fast-non-reasoning`, `temperature: 0.6`, `max_output_tokens: 400`, `promptCacheKey: "strand:composer:<kind>:v1"`. Runs `prefilterText` on the context BEFORE the call; if fail, short-circuit with rejection reason.
2. Prompts: each composer has 3 few-shot examples inline (good reply, mediocre reply, rejected reply), explicit "280 chars max", "no hashtag spam", "no '@everyone'-style CTAs", "match persona voice from persona.md".
3. Prefilter classifier: add an embedding-based similarity check against `config/banned_exemplars.yaml` (new file — seed with 10–15 known-bad tweet examples). Use a local small model (ONNX `bge-small-en-v1.5`) to compute embeddings at load time. At call time, compute text embedding and reject if cosine ≥ 0.8 to any exemplar. Cache embeddings in memory; no network calls in the hot path.
4. Reasoner -> Composer wiring: Reasoner now emits `CandidateEnvelope` with text as a *draft*. Actor calls `grokCompose` to produce final text, then runs `prefilterText` again, then dedup check, then executes. This is the **two-stage composition** — it prevents reasoning-model prose from ever reaching X unmoderated.

   Actually — reread this. Two-stage composition doubles cost. **Default to single-stage**: Reasoner emits final text, Actor does prefilter + dedup only. Add an opt-in `config.composer.twoStage: true` for Phase 4+ when we want A/B quality. Ship single-stage for Phase 0–3.

5. Tests: prefilter with banned-topic hit, profanity hit, embedding-similarity hit, clean pass. Composer test with mocked xAI response.

**Kill switch:** if embedding model fails to load at boot, refuse to boot (explicit error, no silent degradation to regex-only).

**Metrics:** prefilter blocks ≥ 90% of the banned-exemplars corpus in a synthetic test; clean text pass-rate ≥ 98% on a clean-corpus test.

### Subagent D — brain.ts completion + schema + replay-shadow

**Scope:** `src/clients/brain.ts`, `schema.sql`, `scripts/replay-shadow.ts`, `scripts/ingest-followers.ts`, `tests/clients/brain.test.ts`

Current state: `brain.ts` covers boot + Perceiver + Actor outcomes but missing mutation paths used by Consolidator summary persistence and Builder loop (Phase 8). Replay/ingest scripts are stubs.

Tasks:
1. Extend `brain.ts` with:
   - `memory_promote`, `entity_merge`, `belief_set`, `trust_calibrate` (all TS-direct; never exposed to Grok).
   - `context_search`, `temporal_map` (read helpers used by Actor outcome flow to find prior context).
   - A narrow `batchReads(ops: ReadOp[]): Promise<Result[]>` that issues MCP calls concurrently with `Promise.allSettled` and a 5s timeout per op. This replaces ad-hoc chains in Perceiver/Actor.
2. schema.sql additions:
   - `consolidator_runs (id TEXT PRIMARY KEY, batch_id TEXT, status TEXT, created_at, completed_at, summary_json)`.
   - `reasoner_runs (tick_at, response_id, candidate_count, usage_json, cost_ticks)` for audit/backfill.
   - Indexes: `cooldowns(target_id, action_kind)`, `post_embeddings(created_at)`, `action_log(idempotency_key)`.
3. `scripts/replay-shadow.ts`: loads the last N days of `reasoner_runs.response_id` rows, replays each against the current policy gate, reports diff between historical verdict and current verdict. Flags regressions. This is the **policy regression tool** — critical before any policy.yaml edit ships.
4. `scripts/ingest-followers.ts`: pulls the current follower list via X API, upserts one entity per follower via `entity_observe`, tags mutuals. Throttles to stay inside 10k/mo cap — estimate cost upfront and bail if cap would be exceeded.
5. Tests: brain.test.ts with a mocked MCP transport. replay-shadow with a fixture of 5 historical candidates.

**Kill switch:** if brain.ts MCP connection fails at boot, don't fall back — exit 1 with a clear error.

**Metrics:** brain.test.ts ≥ 10 cases; replay-shadow reports a diff summary in < 5s for 100 candidates.

## Phase 2 — Integration boot (single agent, ~30 min)

After all four subagents merge, run sequentially:

1. `pnpm typecheck && pnpm test` — green.
2. Write `scripts/smoke-shadow.ts`: boots orchestrator with `STRAND_MODE=shadow`, mocked X client returning 3 canned mentions, real xAI (if `XAI_API_KEY` set) or mocked xAI. Runs one full cycle: perceive → reason → gate → log. Asserts ≥ 1 candidate minted as `proposed`, gate verdict logged to `decision_log`, no crashes.
3. `pnpm smoke:shadow` — must pass.
4. Update `README.md` with any new env vars or scripts added during Phase 1.
5. Commit: `feat: phase 2 integration boot passing`.

**Kill switch:** if smoke fails, freeze merges until it passes.

**Metrics:** smoke run completes in < 60s, logs include `perceiver.tick`, `reasoner.tick`, `policy.verdict`, zero error-level logs.

## Phase 3 — Shadow-mode gate (operator-in-loop, 48h+)

This is the **hand-off to operator**. Agent stops writing code here; operator runs `pnpm dev` + `pnpm review` against real xAI and real X reads.

Exit criteria (per CLAUDE.md phase gate):
- Perceiver runs 48h without crash.
- Operator labels ≥ 100 candidates manually.
- Shadow reasoner agrees with operator labels on ≥ 80%.
- `docs/PLAN.md` Phase 0 checklist is ticked.

Only then: switch to `gated` mode and begin Phase 4.

## Parallelism map

| Phase | Subagents | Independent? | Blocks next |
|-------|-----------|--------------|-------------|
| 0 | 1 | — | Yes (install + baseline) |
| 1 | A, B, C, D | Yes — worktrees | Partial: C's composer wrapper is used by A's reasoner tests (mock it) |
| 2 | 1 | — | Yes (integration) |
| 3 | 0 (operator) | — | — |

Spawn A/B/C/D in **one message** with four `Agent` calls. Each has `isolation: "worktree"` so edits don't collide. Merge in dependency order: D (schema) → B (uses schema) → A → C.

## Rules for the agent

- Commit after each subagent returns. Small, descriptive commits. Conventional prefix.
- Do NOT enable X writes. Current phase is 0. Only `STRAND_MODE=shadow` in config.
- Do NOT add a new action kind without talking to operator.
- Do NOT install new deps without justifying in the commit body.
- If any subagent finds a spec ambiguity, stop and ask the operator rather than guessing.
- Log `response.id`, `system_fingerprint`, prompt hash on every Grok call. Non-negotiable for replay/audit.

## What NOT to build in this pass

- **Phase 7+ features:** `follow` execution, DMs to non-mutuals, follower ingest at scale. These are blocked on Pro tier + operator review.
- **Phase 8 Builder loop:** `project_proposal` type exists but the Builder queue, sandbox, and attribution flow are a separate brief. Do not start.
- **Metrics dashboard, Grafana wiring:** out of scope for this pass. Add a `/status` CLI and leave dashboard for later.
- **Multi-tenant support:** one agent handle per deployment. Don't generalize.

## Deliverable

A PR (or a series of commits on main) that takes Strand from "scaffold with stubs" to "Phase 2 integration boot passing, ready for Phase 3 operator review". All tests green, shadow smoke green, no new runtime warnings.
