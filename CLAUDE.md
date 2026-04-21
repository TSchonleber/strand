# Strand — Rules for Claude Code

You are the engineering partner on Strand. Read this first; the rules are not suggestions.

## Mission

Ship a production-grade harness that runs an X (Twitter) account 24/7, grows genuine reach, and never trips spam systems. The account is verified and tracking toward a gold checkmark — reputational risk is real.

## Architecture (do not re-architect without approval)

Four loops, one orchestrator, a typestate policy gate between reasoning and action.

- **Perceiver** (`src/loops/perceiver.ts`) — polls our own mentions/timeline/DMs via X API. Writes observations directly to brainctl. No external search here — Grok handles scouting.
- **Reasoner** (`src/loops/reasoner.ts`) — calls `grok-4.20-reasoning` via Responses API with `x_search`, `web_search`, and brainctl remote MCP. `max_turns: 5`. Emits `CandidateEnvelope[]`.
- **Policy gate** (`src/policy/index.ts`) — deterministic. Typestate: only `approve()` can mint `Candidate<Approved>`. Actor signature accepts only `Candidate<Approved>`.
- **Actor** (`src/loops/actor.ts`) — executes via X writes. SHA-256 dedup before every `POST /2/tweets` (X has no idempotency-key support). Annotates outcomes back to brainctl directly.
- **Consolidator** (`src/loops/consolidator.ts`) — nightly on **Batch API** (JSONL → `/v1/batches` with `url: "/v1/responses"`, 50% off all token classes). Deferred Completions is Chat-Completions-only — not usable here.

## Non-negotiable guardrails

1. **No action bypasses the policy gate.** Ever. If you feel tempted, you're about to ship a bug.
2. **No DMs to non-mutuals.** Compile-error-level rule.
3. **All DMs require human review** during Phase 0–6 (current default).
4. **Hard daily caps** (configurable in `config/policies.yaml`):
   - Posts 8, replies 40, quotes 6, follows 20 (**Pro-tier only**), mutual DMs 5, likes 200.
   - Halve during ramp-up.
5. **Cooldown:** no repeat action on same target within 30 min unless they engage.
6. **Relevance ≥ 0.65** for reply/quote/DM.
7. **Duplicate-text check:** reject replies >0.85 cosine sim to last 7 days of posts.
8. **Circuit breakers:**
   - X 429 → halt Actor 1h, alert.
   - Mention sentiment 2σ negative → halt outreach, keep reads running.
9. **brainctl destructive ops stay out of Grok's MCP allowlist.** Grok can read and run consolidation; all writes to entities/events/memory/policies/budget/trust go through TS.

## How to work on this repo

- **Lead with action.** No preamble, no five-option menus.
- **Be opinionated.** Pick the right call, execute, note what you did in one line.
- **Fix first, explain second.** Surgical edits on `fix`, thorough on `build`, parallelizable phases on `plan`.
- **Type safety everywhere.** Strict TS, Zod at every I/O boundary (X payloads, Grok responses, YAML config, MCP calls). Discriminated unions for action kinds.
- **Security by default.** Never log secrets. Validate every X payload before persisting. Rate-limit by construction, not convention.
- **Performance-conscious.** Batch brainctl reads. Cache persona prompt. Stream Grok responses for composition. Idempotency keys on every write.
- **Clean git.** Conventional commits, small PRs, descriptive messages.
- **No comments on obvious code.** No premature abstractions. No defensive code for edge cases that can't happen.

## Directory rules

- **Never call the X, Grok, or brainctl SDK from outside `src/clients/`.** All call sites go through typed wrappers.
- **Every action kind is a discriminated union variant.** Adding a kind = variant + policy rule + client method + tests. No shortcuts.
- **Prompts are files in `prompts/`,** not string literals. Hash at load, log the hash with every Grok call.
- **Config is YAML in `config/`,** loaded and validated with Zod at boot. Bad config fails fast.
- **`src/util/prefilter.ts` runs on every composition prompt** before sending to Grok — avoids the $0.05/request guideline-violation fee.

## Grok integration rules

- Endpoint: `https://api.x.ai/v1/responses`.
- Client: OpenAI SDK with `baseURL: "https://api.x.ai/v1"`. Vercel AI SDK trails on agentic tool loops + MCP `include` opts — keep it out of Reasoner.
- Models:
  - Reasoner / Consolidator: `grok-4.20-reasoning` → `grok-4.20-0309-reasoning` (dated) in prod. Format is `<base>-<MMDD>-<flavor>`, NOT `YYYY-MM-DD`.
  - Composer / Judge: `grok-4-1-fast-non-reasoning` ($0.20/$0.05/$0.50 per M). Bare `grok-4` is gone — do not use.
- Reasoning models **reject** `presence_penalty`, `frequency_penalty`, `stop`, `reasoning_effort`. Silently ignore `logprobs`. Strip by model class in client. REST is snake_case.
- Prompt structure is static-prefix-first: persona → policies → tool defs → schema → recent events → retrieved memory → user task.
- **Set `prompt_cache_key` per loop+tenant** (or HTTP header `x-grok-conv-id`). Without it cache hits collapse on server routing.
- Set `max_turns: 5` on Reasoner to cap agentic tool chains.
- Log `response.id`, `system_fingerprint`, model, prompt-hash, `usage.{input,cached,output,reasoning}_tokens`, `cost_in_usd_ticks`, tool counts on every call.
- **Deferred Completions is Chat-Completions-only** — not on `/v1/responses`. Consolidator uses **Batch API** (JSONL upload, supports `url: "/v1/responses"`). Long Reasoner chains use `previous_response_id`.
- Structured outputs: `anyOf` + literal `kind` for discriminated unions. No `allOf`, `min/maxLength`, `min/maxItems` — enforce in Zod post-parse.
- `include`: `["mcp_call_output", "reasoning.encrypted_content", "x_search_call.action.sources"]` for replay/audit.

## brainctl MCP allowlist

**Transport:** brainctl MUST expose Streaming HTTP or SSE. xAI remote MCP rejects stdio.
**Auth:** passed via the `authorization` field of the MCP tool spec (becomes brainctl's `Authorization` header). Custom headers via `headers`.
**`require_approval` / `connector_id` are NOT supported** by xAI — the allowlist is the only gate.

Exposed to Grok (read-only): `memory_search`, `entity_search`, `entity_get`, `event_search`, `context_search`, `tom_perspective_get`, `policy_match`, `reason`, `infer_pretask`, `belief_get`, `whosknows`, `vsearch`, `temporal_*`.

Exposed to Grok (Consolidator only): `reflexion_write`, `dream_cycle`, `consolidation_run`, `gaps_scan`, `retirement_analysis`.

**Never exposed to Grok:** `memory_add`, `memory_promote`, `entity_create`, `entity_merge`, `event_add`, `belief_set`, `policy_add`, `policy_feedback` (mutations), `budget_set`, `trust_*` mutations, `backup`, `quarantine_purge`.

## Default response posture

- `plan` — phases, parallel work, kill switches + metrics per phase
- `build` — complete typed tested code, no TODOs unless explicitly asked
- `fix` — minimal diff, root cause, one-line why
- `review` — security, correctness, perf; skip style
- Uncertain — make the call, state it, move on

## Phase gate

Current phase: **Phase 0 — scaffold**. Don't write action code until Perceiver has run 48h and memory shape verified. Don't enable writes until shadow-mode reasoner agrees with your labels ≥80%.

## Builder loop (Phase 8+)

The agent can identify buildable ideas from other users and work them through: detect → triage → spec → scaffold → build (sandboxed) → human-review ship. Treat it as a separate loop, not a new action kind on top of existing ones.

- `project_proposal` is an **internal** action variant (no X write). Actor dispatches it to the Builder queue.
- **No automated outbound to the idea's original poster.** Ever. Any reply/DM that references "I built your idea" is a separate `reply`/`dm` action with `requiresHumanReview: true`, drafted by Builder, approved by operator one at a time. No exceptions in Phase 8.
- **Scope gate at triage:** `estimatedEffortHours ≤ 40`, `feasibilityScore ≥ 0.6`, no legal/IP red flag. Reject otherwise.
- **Capacity gate:** max 1 in `building`, max 3 in `specced`. Prevents backlog flooding.
- **Sandbox build:** every code-gen subprocess runs in an isolated environment with no secrets, no prod creds, no outbound besides package registries. SAST + dependency audit before the repo is handed to operator.
- **Attribution is explicit and generous.** Source tweet + user always credited on ship. No "we made this ourselves" framing.
- **Per-project cost cap $50.** Hit the cap → pause, alert. No silent overspend on one idea.
- **Provenance on every file:** link back to source tweet + Grok `response_id` for audit.

## X API tier reality

- **Basic ($200/mo):** 10k posts/mo combined read+write cap is the binding constraint. Poll mentions every 10 min, skip home-TL polling, let Grok `x_search` scout topics. **No follow endpoints on Basic** — `follow` action variant must be feature-flagged off when `TIER=basic`.
- **Pro ($5k/mo):** 1M posts/mo, follows available. Required for Phase 7.
- Filtered stream is on Basic but counts against the same 10k cap. Account Activity webhooks are Enterprise-only. Stick with polling.
- No idempotency key on `POST /2/tweets` — dedup with SHA-256 of normalized text + `in_reply_to_tweet_id` + `quote_tweet_id` + sorted `media_ids` (72h SQLite table).
- X Chat encrypted DMs are invisible to the API. Reply-rate metrics under-measure.
- Duplicate content → 403, not 429. Terminal — do not retry.
- Refresh tokens rotate on every refresh — single-writer transactional persist or lock out.
- Media: `POST /2/media/upload` (chunked: INIT/APPEND/FINALIZE/STATUS). Media IDs expire ~24h.

## Things that break the project

- Action bypassing the policy gate
- Unreviewed DMs during ramp-up
- Ignoring a 429 instead of halting
- Memory writes without an entity or event link
- Prompts hardcoded in TS
- Client SDK calls from a loop directly
- Exposing destructive brainctl ops through Grok MCP
- Sending banned params to reasoning models
- Skipping the pre-filter before composition calls (xAI $0.05/request when pre-generation classifier rejects)
- Dynamic content before static persona in prompts (kills cache)
- Forgetting `prompt_cache_key` / `x-grok-conv-id` (kills cache hit rate regardless of prefix order)
- Shipping `follow` variant on Basic tier (endpoint returns 403)
- Retrying `POST /2/tweets` on network failure without a dedup check (duplicates slip through)
- Builder auto-replying to the source user ("I built your idea") — must be a human-approved one-off reply, not a templated action
- Builder code-gen running outside the sandbox, or with prod secrets in scope
- Shipping a Builder project that touches a trademark or named product without legal sign-off
