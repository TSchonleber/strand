# Strand — Build Plan

Autonomous X presence agent powered by xAI Grok with brainctl long-term memory.

> Revised 2026-04-20 against live X API v2 docs (`docs.x.com`) and xAI docs (`docs.x.ai`). All model names, endpoints, prices, and tier constraints are ground-truthed against the published docs as of that date.

---

## 1. System shape

Four loops, one orchestrator, hard policy gate between reasoning and action. Grok has direct MCP access to brainctl and native `x_search` for external scouting — our code owns the policy gate and the X write path.

```
   ┌──────────────┐        ┌──────────────────────────┐
   │  PERCEIVER   │───────▶│       BRAINCTL (MCP)     │◀───┐
   │ own mentions │        │  entities • events •     │    │
   │  + own TL    │        │  memory • policies •     │    │ remote
   │  + own DMs   │        │  reflexions              │    │ MCP
   └──────────────┘        └───────────┬──────────────┘    │ (HTTP/SSE)
                                       │                    │
   ┌──────────────┐                    │             ┌──────┴──────┐
   │ CONSOLIDATOR │◀── Batch API       │             │   REASONER  │
   │ dream_cycle  │── (50% off, JSONL) │             │   (Grok)    │
   │ reflexion    │                    │             │ + x_search  │
   └──────────────┘                    │             │ + web_search│
                                       ▼             │ + brainctl  │
   ┌──────────────┐            ┌──────────────┐      │   via MCP   │
   │    ACTOR     │◀───────────│ POLICY GATE  │◀─────└─────────────┘
   │ X write API  │            │ deterministic│
   │              │            │ typestate    │
   └──────────────┘            └──────────────┘
```

- **Perceiver** — polls **our own** mentions, home timeline, DMs via X v2. External scouting (topic search, user discovery, thread pulls we're not in) lives in the Reasoner via Grok's `x_search`. Writes observations directly to brainctl.
- **Reasoner** — each tick, calls reasoning Grok via Responses API. Tools: `x_search`, `web_search`, brainctl remote MCP. Emits `CandidateEnvelope[]`. Bounded by `max_turns` to cap agentic tool chains.
- **Policy gate** — deterministic guardrails: rate caps, cooldowns, topical relevance threshold, diversity, banned-topic, duplicate-text. Typestate-enforced — only this layer mints `Candidate<Approved>`.
- **Actor** — executes approved actions via X writes. SHA-256 dedup before every POST /2/tweets (X has no idempotency-key support). Annotates outcomes back to brainctl directly.
- **Consolidator** — nightly via xAI **Batch API** (50% discount, JSONL upload to `/v1/files` then `/v1/batches`). Long-running synchronous Reasoner ticks fall back to `previous_response_id` chaining since Deferred Completions is Chat-Completions-only.

---

## 2. Stack

- **Language:** TypeScript strict, Node 22, ESM.
- **X API v2** via `twitter-api-v2` (Plouc, ≥ 1.29.0). OAuth 2.0 PKCE user context — app-only bearer is insufficient (mentions, DMs, all writes need user context).
- **xAI Grok** via Responses API at `https://api.x.ai/v1/responses`. Client: OpenAI SDK with `baseURL` override (Vercel AI SDK trails on advanced tool/MCP patterns). Auth: `Authorization: Bearer $XAI_API_KEY`.
  - **Reasoner / Consolidator:** `grok-4.20-reasoning` — 2M ctx, $2.00/$0.20/$6.00 per M tokens (in/cached/out). Reasoning-only.
  - **Composer (reply/post prose):** `grok-4-1-fast-non-reasoning` — 2M ctx, $0.20/$0.05/$0.50 per M. 10× cheaper than the `grok-4.20-*` family, no reasoning tax we don't need.
  - **Judge (relevance, sentiment):** `grok-4-1-fast-non-reasoning`, temperature 0.2.
  - **Pin to dated alias in prod:** `grok-4.20-0309-reasoning` (xAI's convention is `<base>-<MMDD>-<flavor>`, NOT `YYYY-MM-DD`).
  - Reasoning models reject `presence_penalty`, `frequency_penalty`, `stop`, `reasoning_effort`. Silently ignore `logprobs`. Strip by model class in client.
  - Optional flagship for nightly deep "dream" passes: `grok-4.20-multi-agent` with `reasoning.effort="low"` (4 agents) — only enable behind a Phase 7 flag.
- **Prompt caching** (auto, ~75–90% off cached tokens):
  - Order is static-prefix-first: persona → policies → tool defs → schema → recent events → retrieved memory → user task.
  - **Set `prompt_cache_key` (Responses API) or HTTP header `x-grok-conv-id` per loop+tenant.** Without this, server routing scatters and cache hit rate craters. Non-optional.
  - Surface `usage.input_tokens_details.cached_tokens` + `usage.cost_in_usd_ticks` in logs.
- **Server-side tools** (per-call $ except MCP):
  - `x_search` — $5/1k. Replaces external X-API scouting. Set `enable_image_understanding: true`, `enable_video_understanding: true` on Reasoner if we want media context (token-priced, no extra per-call fee).
  - `web_search` — $5/1k. Same image flag.
  - `code_execution` — $5/1k. Reserved for Phase 7+.
  - `mcp` — token-only, no per-invocation fee. Limit to allowlist via `allowed_tools`. **`require_approval` is NOT supported by xAI** — allowlist is the only gate.
- **brainctl** — exposed to Grok as **remote MCP server (Streaming HTTP or SSE transport — stdio MCP is not supported by xAI).** Token-priced. Thin TS `brain.ts` wrapper handles direct writes for Perceiver observations and Actor outcomes (where we don't want Grok in the loop).
- **Async reasoning:**
  - **Batch API** for Consolidator (`POST /v1/files` JSONL, then `POST /v1/batches` with `url: "/v1/responses"`). 50% off all token classes. Up to 50,000 requests/file, 200 MB/file, ~24h SLA.
  - **Deferred Completions** is **Chat-Completions-only** (`POST /v1/chat/completions` with `deferred:true`). Not available for Responses API. For long Reasoner work in Phase 7 we use `previous_response_id` chaining + polling.
- **Storage:** SQLite (better-sqlite3) for action log, idempotency keys (SHA-256 of normalized tweet body + targets + media), per-endpoint rate counters, DLQ. brainctl owns the semantic layer.
- **Queue/scheduler:** in-process intervals in dev; BullMQ on Redis in prod, separate queues per loop so a stuck Actor can't starve perception.
- **Runtime:** single Node process (dev) → Docker on Fly.io machine (prod). No k8s.
- **Secrets:** `.env` locally, Fly secrets in prod. Never commit. mTLS to xAI optional later (`https://mtls.api.x.ai`).
- **Observability:** pino → stdout. Every Grok call logs `id`, `system_fingerprint`, model, `usage.{input,cached_input,output,reasoning}_tokens`, `cost_in_usd_ticks`, `tool_calls`. OTel traces. Grafana / Axiom dashboards.
- **Testing:** vitest. `msw` fixtures for X + xAI. Snapshot tests on prompts (hash-stable). E2E shadow against live X reads only.

---

## 3. Repo layout

```
strand/
├── .env.example
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.json
├── biome.json
├── src/
│   ├── index.ts
│   ├── orchestrator.ts
│   ├── loops/{perceiver,reasoner,actor,consolidator}.ts
│   ├── clients/
│   │   ├── x.ts        # twitter-api-v2 wrapper, OAuth refresh-token rotation, header-driven rate buckets
│   │   ├── grok.ts     # Responses API, model-class param strip, prompt_cache_key, max_turns, MCP, batch helpers
│   │   └── brain.ts    # narrow direct-write API (entity_observe, event_add, memory_add, outcome_annotate, policy_feedback)
│   ├── policy/{rateCaps,cooldowns,diversity,topicalRelevance,duplicates,index}.ts
│   ├── prompts/*.md    # loaded at boot, hashed, version-logged
│   ├── types/{actions,events,entities}.ts
│   ├── db/{schema.sql,index.ts,migrations/}
│   └── util/{ratelimit,idempotency,prefilter,log}.ts
├── config/{persona,policies,seed-entities}.yaml
├── scripts/{bootstrap-memory,oauth-setup,ingest-followers,replay-shadow}.ts
└── tests/{policy,loops,fixtures,helpers}/
```

Rules:
- **No SDK call leaves `src/clients/`.** Loops talk to wrappers only.
- **Every action kind is a discriminated union variant.** Adding one = variant + policy rule + client method + tests.
- **Every X write goes through the policy gate.** No back door.
- **Prompts are files,** not strings. Hash at load, log hash on every Grok call.
- **Config is YAML,** Zod-validated at boot. Bad config fails fast.

---

## 4. Data contracts

```ts
type CandidateAction =
  | { kind: "like"; tweetId: string }
  | { kind: "reply"; tweetId: string; text: string }
  | { kind: "quote"; tweetId: string; text: string }
  | { kind: "post"; text: string; mediaIds?: string[] }
  | { kind: "follow"; userId: string }                 // tier-gated: Pro+ only
  | { kind: "dm"; userId: string; text: string }       // mutuals only, human-review until graduated
  | { kind: "bookmark"; tweetId: string };

interface CandidateEnvelope {
  action: CandidateAction;
  rationale: string;
  confidence: number;            // 0..1, Grok self-report
  targetEntityId?: string;       // brainctl entity
  relevanceScore: number;        // computed locally, not from Grok
  sourceEventIds: string[];      // what triggered this
  requiresHumanReview: boolean;  // forced true for DMs and new-topic posts in Phase 0–6
}

type PolicyVerdict =
  | { approved: true }
  | { approved: false; reasons: string[]; ruleIds: string[] };
```

Structured-output schema constraints from xAI: discriminated unions via `anyOf` + literal `kind` enum. **No `allOf`, no `min/maxLength`, no `min/maxItems`** — enforce length/count in TS post-parse instead.

All verdicts logged to brainctl via `policy_feedback` for trust calibration.

---

## 5. Anti-spam design (non-negotiable)

Layered. Each layer rejects independently.

**Hard caps (rolling windows; halve during ramp-up):**
- Posts 8/day. (Counts against `POST /2/tweets` shared 200/24h X cap with retweets.)
- Replies 40/day, 10/hour, max 2 per target user / 24h unless they engage.
- Quotes 6/day.
- Follows 20/day, 5/hour. **Pro+ tier required.**
- Likes 200/day. (X user cap is 200/24h.)
- DMs to mutuals: 5/day, 1 unsolicited per target per 7 days.
- DMs to non-mutuals: **0**, gate enforced at typestate level (X does NOT enforce this; it's our policy alone).

**Cooldowns** (in brainctl per-entity):
- Same user, no repeat action within 30 min unless they engage.
- Re-follow blocked for 30 days after unfollow of same user.

**Quality gates:**
- `relevanceScore ≥ 0.65` for reply / quote / DM. Cosine sim of target embedding to persona-topic vectors + Grok judge.
- Banned-topic hard-reject at gate.
- Duplicate-text reject: > 0.85 cosine sim to anything we posted in last 7 days. Backstops X's own duplicate-content reject (which surfaces as 403, not 429 — terminal, do not retry).

**Diversity:**
- ≤ 30% of daily replies to a single user-cluster.
- No more than 70% of daily actions of one kind.

**Human-in-the-loop (Phase 0–6 default):**
- All DMs, all new-topic posts, all follows with `confidence < 0.8` → review queue.
- Auto-graduate after N reviews with < 5% rejection rate.

**Circuit breakers:**
- X 429 → halt Actor 1h, persist incident event, alert. Honor `x-rate-limit-reset` header.
- X 429 with `title: "UsageCapExceeded"` (monthly cap) → halt Actor for 24h, alert immediately, do NOT retry.
- 403 with spam/automation `type` URI → halt all writes, switch read-only, page operator.
- Mention sentiment > 2σ negative vs 30-day baseline → halt outreach, keep reads running.

---

## 6. X API usage map

External scouting goes through Grok `x_search` — **zero** X API read budget burned on it. X API stays for our own surface plus all writes.

| Need | Endpoint | Auth | Notes |
|---|---|---|---|
| Bootstrap | `GET /2/users/me` | user | scopes `users.read tweet.read`, 75/15min |
| Mentions | `GET /2/users/:id/mentions` | user | 180/15min user, with `since_id` for incremental |
| Home TL | `GET /2/users/:id/timelines/reverse_chronological` | user | 180/15min, user-context only |
| DM events | `GET /2/dm_events` | user | 300/15min; **encrypted X Chat DMs are invisible** |
| DM convo events | `GET /2/dm_conversations/with/:id/dm_events` | user | per-conversation pull |
| Post / reply / quote | `POST /2/tweets` | user | 200 posts/24h user; 300/3h shared with retweets |
| Delete (rollback) | `DELETE /2/tweets/:id` | user | 50/15min user |
| Like / unlike | `POST /2/users/:id/likes` / `DELETE /2/users/:id/likes/:tweet_id` | user | 200/24h, 50/15min |
| Follow / unfollow | `POST /2/users/:id/following` / `DELETE …/:target_user_id` | user | **Pro tier ($5k/mo) required** |
| DM send | `POST /2/dm_conversations/with/:participant_id/messages` | user | 200/15min user, 1000/24h, 10k chars, 1 media/msg |
| Mute / block | `POST /2/users/:id/muting` / `…/blocking` | user | scopes `mute.write` / `block.write` |
| Bookmark | `POST /2/users/:id/bookmarks` | user | 50/15min |
| Media upload | `POST /2/media/upload` (chunked: INIT/APPEND/FINALIZE/STATUS) | user | media IDs expire ~24h |
| Topic / user discovery / off-thread pulls | **Grok `x_search`** | xAI | $0.005/call |

**Tier reality check (PLAN-defining):**

| Tier | $/mo | Posts cap (read+write combined) | Follow endpoints | Verdict |
|---|---|---|---|---|
| Free | $0 | 100r / 500w | none | non-starter |
| Basic | $200 | **10,000/mo** | **NOT available** | only viable if we (a) skip the `follow` action and (b) poll mentions ≤ every 10 min and skip home TL polling |
| Pro | $5,000 | 1,000,000/mo | available | required for the `follow` variant; comfortable for full polling cadence |
| Enterprise | $42k+ | 50M+/mo | + Account Activity webhooks | overkill |

**Recommendation:** start on **Basic**, ship with `follow` variant **disabled at compile time** behind a `TIER` env flag. Mentions poll every 10 min (~4,320 calls/mo, ~0.4 posts/call avg = small). Skip home-TL polling — let Grok `x_search` scout topics instead. Upgrade to Pro the moment we want follows live.

**Realtime alternatives:** Filtered Stream is on Basic but counts against the same 10k cap; Account Activity Webhooks is Enterprise-only. Polling wins for our volume.

**Auth:** OAuth 2.0 PKCE with `offline.access` for refresh tokens. Scopes: `tweet.read users.read tweet.write like.write follows.write dm.read dm.write list.write mute.write block.write bookmark.write offline.access`. **Refresh tokens rotate on every refresh — persist atomically (single-writer transactional update) or you lock yourself out.** Access token TTL is 2h.

**Idempotency:** X has no idempotency-key support on POST /2/tweets. SHA-256 of `normalize(text) + reply.in_reply_to_tweet_id + quote_tweet_id + sorted(media_ids)` keyed in SQLite, last 72h. On suspected duplicate dispatch, query own-timeline post-hoc and DELETE the younger duplicate.

**Errors:**
- `401` → refresh token, retry once.
- `403` duplicate content (text dedup miss) → terminal, log, no retry.
- `403` spam/automation flag → trip circuit breaker, halt writes.
- `429` → honor `x-rate-limit-reset` header (unix seconds, no `Retry-After`).
- `429 UsageCapExceeded` (monthly) → halt 24h, alert.

---

## 7. Grok integration

- **Endpoint:** `POST https://api.x.ai/v1/responses`. Auth bearer.
- **Client:** OpenAI SDK with `baseURL: "https://api.x.ai/v1"`. Vercel AI SDK is fine for Composer/Judge but trails on agentic tool loops + MCP `include` opts — keep it out of Reasoner.
- **Models** (see §2 for full pricing):
  - Reasoner / Consolidator: `grok-4.20-reasoning` → `grok-4.20-0309-reasoning` (dated) in prod.
  - Composer / Judge: `grok-4-1-fast-non-reasoning`.
- **Param hygiene per model class** (centralized in `clients/grok.ts`):
  - Reasoning: never send `presence_penalty`, `frequency_penalty`, `stop`, `reasoning_effort`. `logprobs` is silently ignored — drop it.
  - Non-reasoning: standard params accepted. `temperature`, `top_p`, `seed`, `n` all supported.
  - REST is snake_case; the wrapper accepts camelCase from callers and converts.
- **Prompt structure** (cache-optimized): static prefix first → persona.md → policy catalog → tool definitions → CandidateEnvelope schema → dynamic suffix (recent events, retrieved memory, target context, user task).
- **`prompt_cache_key` per loop+tenant.** Use a stable string like `strand:reasoner:v3:<persona_hash>`. Send via Responses-API field or HTTP header `x-grok-conv-id`. Without it cache hits collapse on multi-instance routing.
- **Server-side tools enabled per loop:**
  - Reasoner: `x_search`, `web_search`, brainctl MCP. `max_turns: 5`. `parallel_tool_calls: true`.
  - Consolidator: brainctl MCP only.
  - Composer / Judge: no tools.
- **brainctl as remote MCP** — register per request:
  ```json
  {
    "type": "mcp",
    "server_url": "https://brainctl.…/mcp",
    "server_label": "brainctl",
    "authorization": "BRAINCTL_TOKEN",
    "headers": { "X-Tenant": "strand" },
    "allowed_tools": [
      "memory_search","entity_search","entity_get","event_search","context_search",
      "tom_perspective_get","policy_match","reason","infer_pretask","belief_get",
      "whosknows","vsearch","temporal_auto_detect","temporal_chain","temporal_context",
      "temporal_causes","temporal_effects","temporal_map"
    ]
  }
  ```
  Consolidator allowlist additionally enables `reflexion_write`, `dream_cycle`, `consolidation_run`, `gaps_scan`, `retirement_analysis`. **Never expose** `memory_add`, `memory_promote`, `entity_create`, `entity_merge`, `event_add`, `belief_set`, `policy_add`, `policy_feedback` (mutations), `budget_set`, `trust_*` mutations, `backup`, `quarantine_purge`. xAI MCP has no `require_approval` — the allowlist IS the gate. brainctl MUST speak Streaming HTTP or SSE; stdio MCP is rejected.
- **Structured outputs:** strict JSON-Schema, `anyOf` + literal `kind` for unions. No `allOf`, `min/maxLength`, `min/maxItems` — enforce in Zod after parse.
- **`include` flags** worth turning on:
  - `mcp_call_output` — surfaces brainctl tool outputs in the response we log/replay.
  - `reasoning.encrypted_content` — store the encrypted reasoning trace for audit/replay without re-paying reasoning tokens.
  - `web_search_call.action.sources` / `x_search_call.action.sources` — for citation retention.
- **Async:**
  - Consolidator: Batch API JSONL (`POST /v1/files` → `POST /v1/batches` with `url: "/v1/responses"`). 50% off all token classes; tools + MCP work in batch. Submit nightly at 03:00 UTC; results within 24h.
  - Reasoner: synchronous. If a tick needs more than ~60s, chain via `previous_response_id` rather than polling Deferred (Deferred is Chat-Completions-only).
- **Refusal tax:** $0.05/request when xAI's pre-generation guideline classifier rejects a Responses-API call. Pre-filter every composition prompt locally (`util/prefilter.ts`: regex banlist + tiny embedding classifier). Post-generation refusals bill as normal completions, not the $0.05 fee.
- **Logging on every call:** `response.id`, `system_fingerprint`, model, prompt-hash, `usage.{input,cached,output,reasoning}_tokens`, `cost_in_usd_ticks`, `server_side_tool_usage`, `tool_calls.length`. This is the basis for replay + per-loop cost attribution.

---

## 8. brainctl usage map

brainctl runs as a **remote MCP server (HTTP/SSE)** exposed to Grok. Grok calls it during reasoning. TS calls it only on the audit-critical paths (observations, outcomes).

- **On boot (TS):** `agent_register`, `belief_seed` (persona, banned topics, goals), `policy_add` per guardrail, `budget_set`. Register brainctl MCP in Grok client config.
- **Perceiver tick (TS direct):** `event_add` per observation, `entity_observe` per user touched, `memory_add` for content worth remembering, `temporal_auto_detect` for chain linking.
- **Reasoner tick (Grok via MCP, read-only allowlist):** `context_search`, `memory_search`, `infer_pretask`, `tom_perspective_get`, `policy_match`. Grok decides what to call.
- **Actor outcome (TS direct):** `outcome_annotate`, `policy_feedback`, `trust_update_contradiction` if reality diverges from prediction.
- **Nightly Consolidator (Grok via Batch API):** `dream_cycle`, `consolidation_run`, `reflexion_success` / `reflexion_failure_recurrence`, `gaps_scan`, `decay_report`, `retirement_analysis`. TS triggers `backup` separately.
- **Weekly (TS-triggered, Grok-executed):** `expertise_build`, `knowledge_report`, `trust_audit`, `pagerank` over entity graph for retargeting.

---

## 9. Phased build

Each phase ends with a kill switch and a metrics check. Sequential within a phase; phases ship one at a time (risk-gated).

**Phase 0 — Scaffold (½ day) — current**
Repo, tsconfig strict, biome, env loader, `bootstrap-memory`, `oauth-setup`, pino, X/Grok/brain client skeletons, smoke tests per client. Confirm `grok-4.20-0309-reasoning` round-trips with structured output and brainctl MCP responds via HTTP/SSE. Set `prompt_cache_key`; verify `cached_tokens > 0` on second call.

**Phase 1 — Perceiver, read-only (1 day)**
Poll mentions every 10 min, DMs every 5 min. Skip home TL on Basic (Grok scouts via `x_search` instead). Write to brainctl. `strand status` CLI renders last N events. **Run 48h** then sanity-check memory shape: entity counts, event chains, no orphan memories. Kill switch: env flag halts loop in <5s.

**Phase 2 — Reasoner in shadow (1 day)**
Every 10 min the Reasoner emits ≤ 5 CandidateEnvelopes. Actor disabled. SQLite + brainctl logged with `mode: "shadow"`. `strand review` CLI walks candidates and labels good/bad. Tune prompts + relevance threshold. **Gate to Phase 3:** ≥ 80% agreement between policy verdict and your manual labels over ≥ 100 candidates.

**Phase 3 — Low-risk actions live (2 days)**
Enable `like` and `bookmark` only. Full policy stack on. Caps at half values. Track: X health, mention sentiment baseline, follower delta, error rate. Shadow mode stays on for everything else. **Kill switch:** flag → drain action queue, no new dispatch.

**Phase 4 — Replies (3 days)**
Enable `reply`. Mandatory human review for `confidence < 0.85`. Every reply persists its source-event chain. Ramp to full caps after 1 week clean. (Follows still gated — needs Pro tier.)

**Phase 5 — Quotes + posts (2 days)**
Enable `quote` and `post`. Posts require a `content_plan` memory written earlier the same day — no spontaneous originals. Consolidator promotes good topics via `expertise_update`.

**Phase 6 — DMs to mutuals (2 days)**
DM only to mutuals who engaged in last 14 days. Hard 1/week per target. 100% human review for first 30 days.

**Phase 7 — Follows + dream (ongoing)**
Upgrade X to Pro when ROI justifies. Enable `follow` variant. Consolidator runs `grok-4.20-multi-agent` weekly for deeper retirement_analysis + persona refactor proposals (require human approval).

**Phase 8 — Builder (ideas → shipped projects)**
Detect buildable ideas from other users, triage, spec, and build — without turning the account into an "I built your idea" farm.

Sub-phases, each gated:

- **8a — Idea detection & triage (2 days).** Reasoner scouts via `x_search` for buildable-idea patterns: "I wish X existed", "someone should build Y", explicit feature requests, pain-point threads. Emits new `project_proposal` action variant (internal, not an X write) with idea summary, problem statement, proposed approach, estimated effort, required capabilities, feasibility 0..1, legal/IP risk flags, competitive landscape. Policy gate requires `feasibilityScore ≥ 0.6`, no legal/IP red flag, effort ≤ 40h. Approved proposals write to a `project_proposals` SQLite table + brainctl memory. **No outbound communication yet.** Kill switch: disable `project_proposal` variant.
- **8b — Spec authoring (2 days).** Builder loop picks approved proposals nightly, asks Grok reasoning to write a full PRD (problem, users, non-goals, architecture, success criteria, rollback plan) into `projects/<slug>/SPEC.md`. Human review required before anything else.
- **8c — Scaffold & build (sandboxed) (ongoing).** For specs a human greenlights, Builder spawns a code-gen subagent (Claude Code or Grok `code_execution` for simple stuff) inside `projects/<slug>/` — sandboxed, no deploy, no outbound network except package registries. Subagent produces repo + tests + README. Builder runs tests, logs results. Output is a local repo the operator can review and ship manually. **Nothing deploys automatically. Nothing publishes to X automatically.**
- **8d — Attribution & outreach (gated, ongoing).** Once a project is human-shipped, Builder drafts a reply or DM to the original poster (credit + link), routed through the review queue exactly like every other DM. Hard rule: we never claim to have "built your idea" without the operator approving that specific piece of outbound communication. Attribution is explicit and generous; license is clear; no scraping-then-competing.

Data model additions:
- `project_proposals` table: `id, source_tweet_id, source_user_id, idea_summary, feasibility_score, status ∈ { draft, approved, speccing, specced, building, built, shipped, abandoned }, spec_path, repo_path, source_envelope_json, created_at, updated_at`.
- `project_outcomes` table: `project_id, outcome ∈ { shipped, abandoned, ip_conflict, too_complex }, operator_notes, shipped_at`.

Guardrails specific to Builder:
- **No automated outbound to the original poster.** Ever. Attribution DMs are human-approved one at a time.
- **No claim of co-authorship** unless the original poster is given the repo link + license before it's public.
- **IP/licensing check** at 8a: if the source post names a company, product, or trademark, flag for legal-review, skip.
- **Scope gate:** `estimatedEffortHours ≤ 40` at 8a. We don't take on 6-week builds from a tweet.
- **Capacity gate:** at most 1 in `building` and 3 in `specced` at a time — prevents the agent from flooding the backlog.
- **Sandbox:** all code-gen runs in a dedicated sandbox (Docker container or Fly machine) with no secrets, no prod creds, no outbound besides npm/PyPI.
- **Cost cap:** per-project xAI spend cap at $50 (configurable). Hit cap → pause, alert.
- **Provenance:** every file in a generated repo is linked back to the source tweet + reasoning `response_id` for full audit.

---

## 10. Metrics

From Phase 1 onward:
- **Reach:** impressions, profile visits, follower delta, mutual-follow rate.
- **Quality:** reply sentiment (Judge), reply-to-reply rate, thread depth.
- **Safety:** 429 rate, monthly-cap headroom, negative-mention sentiment, block/mute inferred from graph deltas, X health warnings.
- **Agent:** candidates/min, approval rate, action success rate, policy rejections by rule, brainctl memory count by tier, consolidation churn.
- **Cost:** per-loop xAI spend (sum `cost_in_usd_ticks`), prompt-cache hit ratio, X monthly post-cap utilization, brainctl token consumption.

Dashboard in Grafana / Axiom. Alert on any safety metric 2σ above 7-day baseline.

---

## 11. Risks + mitigations

- **X tier overflow:** Basic 10k posts/mo cap is the binding constraint. Mitigation: long poll cadence (10 min), no home-TL polling, monthly-cap meter halt at 90%, plan Pro upgrade before Phase 7.
- **Follow gate locked on Basic:** disable `follow` variant at compile time via `TIER=basic` flag. Don't ship Phase 7 without `TIER=pro`.
- **DM surface partial:** X Chat encrypted DMs are invisible. Reply-rate metric will under-measure. Document in dashboards — don't trust DM reply rate as ground truth.
- **POST /2/tweets duplicate races:** no idempotency key. Mitigation: SHA-256 dedup table (72h), single-retry only on network error, post-hoc reconcile via own-timeline + DELETE.
- **Refresh-token rotation:** persist atomically; lockout if we lose the new token. Single-writer transactional update.
- **Spam classifier trip:** any 403 with `automated_behavior` type → halt, 24h cooldown, manual review. Keep follow churn < 5%.
- **Grok drift:** persona prompt hashed; diff outputs vs golden fixtures weekly; `reflexion_failure_recurrence` catches behavioral drift.
- **Memory blowup:** brainctl `meb_prune`, `consolidation_run`, `retirement_analysis` weekly. Hard cap warm tier.
- **Cost blowup:** brainctl `budget_set`; xAI per-loop cost meter (`cost_in_usd_ticks`); hard stop at monthly cap.
- **Cache miss:** `prompt_cache_key` must be set per loop+tenant. Alarm on cached_tokens / input_tokens ratio < 50% on Reasoner.
- **MCP timeout silent degradation:** xAI doesn't surface MCP failures clearly. Backstop with TS-side brainctl health checks every 5 min.
- **Builder IP/attribution blowback:** scraping a stranger's idea from X and shipping it is legally grey and reputationally toxic if done wrong. Mitigation: flag trademarks + named products at triage; generous attribution on ship; operator-gated outbound; no "I built your idea" posts ever without explicit approval on that specific wording.
- **Builder code-gen drift:** autonomous code-gen produces vulnerable code by default. Mitigation: sandbox every build, run SAST + dependency audit in the Builder pipeline, no secrets in the sandbox, human review before any push to a public repo or deploy.
- **Builder cost runaway:** deep reasoning over long specs burns tokens fast. Per-project cost cap at $50, pause-and-alert on hit.

---

## 12. Day-1 checklist

- [ ] Pull X + xAI keys into `.env` from secure store
- [ ] Repo scaffold green: `pnpm install && pnpm test && pnpm typecheck`
- [ ] `scripts/oauth-setup.ts` → capture OAuth2 refresh token, write to `.env` with rotation-safe persistence wrapper
- [ ] `scripts/bootstrap-memory.ts` → seed persona, goals, banned topics, policies
- [ ] Confirm tier in env (`TIER=basic` for now); verify `follow` variant compiles out
- [ ] Smoke-test Grok: `grok-4.20-0309-reasoning` Responses call with `tools: [x_search]` + structured output → got `output[]` with `function_call` + final `message`
- [ ] Smoke-test brainctl MCP via Grok: confirm Streaming HTTP/SSE transport, MCP tool call appears in `output[]` with `include: ["mcp_call_output"]`
- [ ] `prompt_cache_key="strand:reasoner:v0"` set; second identical call shows `usage.input_tokens_details.cached_tokens > 0`
- [ ] SQLite dedup table for tweet hashes (SHA-256 of normalized text + targets + media), 72h TTL
- [ ] Per-endpoint token-bucket parsing `x-rate-limit-{limit,remaining,reset}` headers
- [ ] Monthly-cap meter parsing `x-user-limit-24hour-*` (and the X usage endpoint); halt at 90%
- [ ] Pre-filter regex + embedding banlist wired to every Composer call (saves the $0.05 refusal tax)
- [ ] Perceiver: 48h read-only run; verify entity/event/memory shape in brainctl
- [ ] Shadow Reasoner: review 100 candidates; tune until ≥ 80% label agreement
- [ ] Ship Phase 3

---

## 13. References

- xAI overview: <https://docs.x.ai/overview>
- xAI single-file docs bundle (use this for research passes): <https://docs.x.ai/llms.txt>
- Models + pricing: <https://docs.x.ai/developers/models>
- Responses API quickstart: <https://docs.x.ai/developers/quickstart>
- Tools overview: <https://docs.x.ai/developers/tools/overview>
- `x_search`: <https://docs.x.ai/developers/tools/x-search>
- `web_search`: <https://docs.x.ai/developers/tools/web-search>
- Remote MCP: <https://docs.x.ai/developers/tools/remote-mcp>
- Function calling: <https://docs.x.ai/developers/tools/function-calling>
- Structured outputs: <https://docs.x.ai/developers/model-capabilities/text/structured-outputs>
- Reasoning: <https://docs.x.ai/developers/model-capabilities/text/reasoning>
- Streaming: <https://docs.x.ai/developers/model-capabilities/text/streaming>
- Prompt caching: <https://docs.x.ai/developers/advanced-api-usage/prompt-caching>
- Batch API: <https://docs.x.ai/developers/advanced-api-usage/batch-api>
- Deferred (Chat-Completions only): <https://docs.x.ai/developers/advanced-api-usage/deferred-chat-completions>
- Rate limits: <https://docs.x.ai/developers/rate-limits>
- Release notes: <https://docs.x.ai/developers/release-notes>
- X API overview: <https://docs.x.com/overview>
- X auth (OAuth 2.0 PKCE): <https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code>
- X rate limits: <https://docs.x.com/x-api/fundamentals/rate-limits>
- X pricing: <https://docs.x.com/x-api/getting-started/pricing>
- Manage posts: <https://docs.x.com/x-api/posts/manage-tweets/introduction>
- Chunked media upload: <https://docs.x.com/x-api/media/quickstart/media-upload-chunked>
- DM send: <https://docs.x.com/x-api/direct-messages/manage/api-reference/post-dm_conversations-with-participant_id-messages>
- Account Activity (Enterprise): <https://docs.x.com/x-api/account-activity/introduction>
- twitter-api-v2 SDK: <https://www.npmjs.com/package/twitter-api-v2>
