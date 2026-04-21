# Strand — Architecture

Authoritative technical map of the Strand agent harness. Every diagram below
is grounded in the current source tree at `main`; when code and diagram diverge,
the code wins and this doc is the bug.

> **Provider-agnostic note (2026-04-21):** Strand now runs on four LLM providers
> behind the `LlmProvider` interface at `src/clients/llm/`: OpenAI-compatible,
> Anthropic, xAI, Gemini. Pick with `LLM_PROVIDER` env. The diagrams below
> reference xAI endpoints by default because it's the Phase-0 default provider
> and the richest feature set (x_search + Batch + prompt_cache_key +
> previous_response_id). Swap provider and adapters translate to each native
> wire format; loops degrade gracefully on missing capabilities.

Scope: runtime architecture, data flow, gate typestate, brainctl access model,
SQLite schema. Does NOT cover deployment topology (Fly.io), prompt
engineering details (`prompts/`), or policy tuning heuristics (`config/policies.yaml`).

---

## 0. Loop cadences, models, cache keys

| Loop | Cadence (dev) | Model | `prompt_cache_key` | Tools granted |
|---|---|---|---|---|
| Perceiver | 120 s | — (no LLM) | — | X v2 (mentions, home TL, DM events) |
| Reasoner | 300 s | `grok-4.20-reasoning` | `strand:reasoner:v1` | `x_search`, `web_search`, brainctl MCP (read) |
| Consolidator (submit) | 24 h | `grok-4.20-reasoning` via Batch API | `strand:consolidator:v1` | brainctl MCP (consolidator allowlist) |
| Consolidator (poll) | 30 min *(not yet wired in orchestrator)* | — | — | — |
| Composer (lib, not wired) | on-demand | `grok-4-1-fast-non-reasoning` | `strand:composer:<kind>:v1` | none (prefilter blocks pre-call) |
| Actor | event-driven (fires after Reasoner approves) | — | — | X v2 writes |

Dev cadences live in `src/orchestrator.ts`. Prod cadences move to BullMQ per loop.

---

## 1. System topology (L0)

```mermaid
flowchart LR
  subgraph EXT[External services]
    X[X API v2\nuser OAuth2 PKCE]
    XAI["xAI Responses API\napi.x.ai/v1"]
    BRAIN[("brainctl\nremote MCP\nHTTP/SSE")]
    BRAIN_LOCAL[("brainctl\nlocal stdio MCP")]
  end

  subgraph STRAND[strand process]
    direction TB
    PERC["Perceiver<br/>every 120s<br/>own mentions + home TL + DMs"]
    REAS["Reasoner<br/>every 300s<br/>grok-4.20-reasoning"]
    CONS["Consolidator<br/>submit 24h · poll 30min<br/>xAI Batch API"]
    GATE{{"Policy Gate<br/>8 rules + typestate<br/>mints Candidate&lt;Approved&gt;"}}
    ACTOR["Actor<br/>event-driven<br/>SHA-256 dedup"]
    SQL[("SQLite WAL<br/>action_log · cooldowns ·<br/>reasoner_runs · consolidator_runs ·<br/>post_embeddings · perceived_events ·<br/>human_review_queue · dlq · rate_counters")]
  end

  X -->|"GET mentions / timeline / dm_events"| PERC
  PERC -->|"perceived_events row"| SQL
  PERC -->|"event_add"| BRAIN_LOCAL

  SQL -->|"recent_events (last 50)"| REAS
  REAS -->|"/v1/responses<br/>max_turns=5<br/>include=[mcp,reasoning,x_search]"| XAI
  REAS -->|"memory_search · entity_get · context_search · tom_perspective_get"| BRAIN
  REAS -->|"CandidateEnvelope[]"| GATE
  REAS -->|"reasoner_runs row"| SQL

  GATE -->|"approved: Candidate&lt;approved&gt;"| ACTOR
  GATE -->|"rejected: reasons + ruleIds"| SQL
  ACTOR -->|"POST /2/tweets · likes · dm_conversations"| X
  ACTOR -->|"action_log row · rate_counters inc"| SQL
  ACTOR -->|"outcome_annotate · policy_feedback"| BRAIN_LOCAL

  CONS -->|"JSONL upload /v1/files"| XAI
  CONS -->|"POST /v1/batches<br/>endpoint=/v1/responses<br/>50% off"| XAI
  CONS -->|"dream_cycle · consolidation_run ·<br/>gaps_scan · retirement_analysis ·<br/>reflexion_write"| BRAIN
  CONS -->|"consolidator_runs row"| SQL

  classDef ext fill:#1f2937,stroke:#6b7280,color:#f9fafb
  classDef loop fill:#0f172a,stroke:#3b82f6,color:#e0e7ff
  classDef gate fill:#450a0a,stroke:#ef4444,color:#fee2e2
  classDef store fill:#064e3b,stroke:#10b981,color:#d1fae5
  class X,XAI,BRAIN,BRAIN_LOCAL ext
  class PERC,REAS,CONS,ACTOR loop
  class GATE gate
  class SQL store
```

Non-negotiables encoded in the diagram:
- **Grok never touches the X write API.** All X writes go through Actor ← Gate ← Reasoner.
- **Grok never performs brainctl mutations.** Writes to brain.db are TS-direct via the stdio MCP path.
- **No path bypasses the Policy Gate.** Actor's signature (`Candidate<"approved">`) is compile-enforced.

---

## 2. Reasoner tick — wire detail

```mermaid
sequenceDiagram
    autonumber
    participant O as orchestrator<br/>every 300s
    participant R as reasonerTick<br/>(src/loops/reasoner.ts)
    participant DB as SQLite
    participant P as prompts/<br/>(persona + reasoner.system)
    participant G as grokCall<br/>(src/clients/grok.ts)
    participant X as xAI /v1/responses
    participant B as brainctl MCP<br/>(remote, HTTP/SSE)

    O->>R: invoke
    R->>DB: SELECT last 50 perceived_events
    R->>P: loadPrompt("persona"), loadPrompt("reasoner.system")<br/>(file hash logged with every call)
    R->>G: grokCall({<br/> model: grok-4.20-reasoning,<br/> systemPrompts: [persona, reasoner, hashes],<br/> userInput: JSON(mode, persona, recent_events, instruction),<br/> tools: [x_search, web_search, brainctlMcpTool(READ_ALLOWLIST)],<br/> toolChoice: "auto",<br/> parallelToolCalls: true,<br/> maxTurns: 5,<br/> maxOutputTokens: 6000,<br/> promptCacheKey: "strand:reasoner:v1",<br/> include: [mcp_call_output, reasoning.encrypted_content, x_search_call.action.sources],<br/> responseSchema: CandidateBatch (anyOf per action.kind)<br/>})
    G->>X: POST /v1/responses (reasoning params stripped by model class)
    X-->>B: MCP tool invocations (read-only allowlist)
    B-->>X: tool results
    X-->>G: { id, output_text, output[], usage, system_fingerprint, cost_in_usd_ticks }

    alt candidates.length == 0 AND toolCalls.length > 0
        Note over R,G: "stuck mid-thought" — retry once with previous_response_id
        R->>G: grokCall({ ..., previousResponseId: resp1.id, userInput: "" })
        G->>X: POST /v1/responses
        X-->>G: resp2
    end

    R->>R: CandidateEnvelopeSchema.safeParse per candidate<br/>(drop malformed, warn-log)
    R->>DB: INSERT INTO reasoner_runs<br/>(response_id, previous_response_id,<br/> candidate_count, tool_call_count,<br/> usage_json, cost_in_usd_ticks,<br/> stuck_mid_thought)
    R-->>O: CandidateEnvelope[]
```

**Schema shape for `responseSchema` (xAI constraints):**
- Root: `{ type: "object", required: ["candidates"], properties: { candidates: { type: "array", items: { ... } } } }`
- Each candidate's `action` is `{ anyOf: [<literal-kind variant>, ...] }` — one variant per `ActionSchema` discriminant (like, bookmark, reply, quote, post, follow, unfollow, dm, project_proposal).
- **No `allOf`, no `min/maxLength`, no `min/maxItems`** — rejected by xAI. Enforcement happens in Zod (`CandidateEnvelopeSchema`) after parse.

**Param hygiene by model class** (centralized in `buildRequest`, `src/clients/grok.ts:130`):
- Reasoning models drop `temperature`, `presence_penalty`, `frequency_penalty`, `stop`, `reasoning_effort`, `logprobs`.
- Non-reasoning models accept `temperature`.
- REST body is snake_case; camelCase from callers is converted in `buildRequest`.

---

## 3. Policy Gate — 8 rules + typestate

```mermaid
stateDiagram-v2
    [*] --> Proposed: reasoner emits CandidateEnvelope
    Proposed --> BannedTopic
    BannedTopic --> Prefilter: pass
    BannedTopic --> Rejected: reasons += banned_topic:*
    Prefilter --> RateCaps: pass
    Prefilter --> Rejected: reasons += prefilter:*
    RateCaps --> Cooldown: pass
    RateCaps --> Rejected: reasons += daily_cap_exceeded / hourly_cap_exceeded
    Cooldown --> Relevance: pass
    Cooldown --> Rejected: reasons += cooldown_active
    Relevance --> Duplicate: pass
    Relevance --> Rejected: reasons += relevance_below_threshold
    Duplicate --> Diversity: pass
    Duplicate --> Rejected: reasons += duplicate_text_cosine_sim_>_0.85 (7d)
    Diversity --> DmSafety: pass
    Diversity --> Rejected: reasons += diversity_share_cluster / diversity_share_kind
    DmSafety --> HumanReviewCheck: pass
    DmSafety --> Rejected: reasons += dm_no_mutual_context
    HumanReviewCheck --> Approved: not required
    HumanReviewCheck --> Rejected: reason = requires_human_review
    Approved --> [*]: Candidate<approved> minted<br/>(via __unsafeMarkApproved)
    Rejected --> [*]: Candidate<rejected> minted<br/>+ reasons[] + ruleIds[]
```

Collect-all semantics: gate does NOT short-circuit. Every independent rule
runs even if earlier ones failed; the final verdict carries the full
`reasons[]` + `ruleIds[]`. This feeds `policy_feedback` → trust calibration
and makes rejection diffing meaningful (`scripts/replay-shadow.ts`).

**Typestate enforcement:**

```ts
// src/types/actions.ts
export type Candidate<S extends CandidateState = "proposed"> =
  CandidateEnvelope & Brand<S>;

// only src/policy/index.ts calls __unsafeMarkApproved
// Actor signature:
export async function executeApproved(
  deps: ActorDeps,
  c: Candidate<"approved">,   // ← compile error if you hand it a <proposed>
  decisionId: string,
): Promise<void>;
```

Typestate closes the "Reasoner sneakily calls Actor" hole at compile time —
not at runtime, not by code review.

---

## 4. Consolidator — Batch API flow

```mermaid
flowchart TB
  subgraph SUB[consolidatorRun · nightly 24h]
    direction TB
    B1["buildJsonl()<br/>5 task lines:<br/>• dream_cycle<br/>• consolidation_run<br/>• gaps_scan<br/>• retirement_analysis<br/>• reflexion_write"]
    B2["grokFilesUpload<br/>(jsonl, purpose='batch')"]
    B3["grokBatchCreate<br/>{ inputFileId,<br/>  endpoint: '/v1/responses',<br/>  completionWindow: '24h' }"]
    B4["INSERT consolidator_runs<br/>status='queued'"]
  end

  subgraph POLL[consolidatorPoll · 30min · NOT WIRED YET]
    direction TB
    P1["SELECT * FROM consolidator_runs<br/>WHERE status IN ('queued','in_progress')"]
    P2{"grokBatchGet(batch_id)"}
    P3a["status='in_progress'<br/>UPDATE row"]
    P3b["status='completed'<br/>grokBatchResults(id)<br/>→ JSONL stream"]
    P3c["status='failed'<br/>UPDATE error column"]
    P4["aggregateResults:<br/>{ changed, insights, gaps,<br/>  retirements, failed_tasks }"]
    P5["UPDATE consolidator_runs<br/>summary_json, completed_at"]
  end

  XAI[(xAI)]
  BRAIN[(brainctl MCP<br/>CONSOLIDATOR_MCP_ALLOWLIST)]
  DB[(SQLite)]

  B1 --> B2 --> B3 --> B4 --> DB
  B2 -.-> XAI
  B3 -.-> XAI

  DB --> P1 --> P2
  P2 -->|"validating / in_progress"| P3a --> DB
  P2 -->|"completed"| P3b --> P4 --> P5 --> DB
  P2 -->|"failed / expired / cancelled"| P3c --> DB
  P3b -.-> XAI
  P4 -.->|"tool calls in each batch line"| BRAIN
```

**Batch line format** (`buildBatchRequestLine` in `src/clients/grok.ts`):

```jsonl
{"custom_id":"dream_cycle","method":"POST","url":"/v1/responses","body":{...}}
{"custom_id":"consolidation_run","method":"POST","url":"/v1/responses","body":{...}}
...
```

Each body embeds model + persona/consolidator prompts + brainctl MCP tool
config + `prompt_cache_key: "strand:consolidator:v1"` + response schema
(`{ changed, insights, gaps, retirements }` — all arrays of strings).

**Why not Deferred Completions?** It's Chat-Completions-only (`/v1/chat/completions`),
not available on `/v1/responses`. Batch API is the only path that gives us
async + 50% off for Responses API. Verified against docs.x.ai 2026-04-20.

**Partial failure handling:** if `request_counts.failed > 0` but at least one
line succeeded, row is marked `status='completed'` with `failed_tasks` surfaced
in `summary_json`. Fully failed batches get `status='failed'`.

---

## 5. Actor — execution path

```mermaid
flowchart TB
  IN["executeApproved(deps, c: Candidate&lt;approved&gt;, decisionId)"]
  IN --> K["idempotencyKey(action, sourceEventIds)<br/>SHA-256(normalize(text) + reply.in_reply_to +<br/>quote_tweet_id + sorted(media_ids))"]
  K --> CHK{"SELECT status<br/>FROM action_log<br/>WHERE idempotency_key=?"}
  CHK -->|"status='executed'"| SKIP["actor.skip_duplicate"]
  CHK -->|"not found"| REC["INSERT action_log<br/>status='approved'"]

  REC --> MODE{"STRAND_MODE?"}
  MODE -->|"shadow"| SH["log + UPDATE status='executed'<br/>no X call"]
  MODE -->|"gated or live"| DISPATCH

  DISPATCH["x.execute(c.action)<br/>switch(action.kind)"]
  DISPATCH --> LIKE["like:<br/>c.v2.like(userId, tweetId)"]
  DISPATCH --> BOOK["bookmark:<br/>c.v2.bookmark(tweetId)"]
  DISPATCH --> FOLLOW["follow:<br/>c.v2.follow(userId, targetId)<br/>(tier-gated)"]
  DISPATCH --> POST["post:<br/>c.v2.tweet({text})"]
  DISPATCH --> REPLY["reply:<br/>c.v2.tweet({text, reply})"]
  DISPATCH --> QUOTE["quote:<br/>c.v2.tweet({text, quote_tweet_id})"]
  DISPATCH --> DM["dm:<br/>c.v2.sendDmToParticipant"]
  DISPATCH -.->|"project_proposal"| ERR["throw: internal action,<br/>never reaches x.execute"]

  LIKE --> OK
  BOOK --> OK
  FOLLOW --> OK
  POST --> OK
  REPLY --> OK
  QUOTE --> OK
  DM --> OK
  OK["UPDATE action_log<br/>status='executed'<br/>x_object_id, executed_at, duration_ms"]
  OK --> RATE["rl.increment(DAY)<br/>+ rl.increment(HOUR) for follow/reply"]
  RATE --> CD["recordActionCooldowns<br/>(cooldowns table)"]
  CD --> EMB["if 'text' in action:<br/>recordPostText → post_embeddings"]
  EMB --> ANN["brain.outcome_annotate<br/>{ decision_id, outcome: 'success' }"]

  DISPATCH -.->|"throws"| FAIL["UPDATE action_log<br/>status='failed'<br/>error_code, error_message<br/>brain.outcome_annotate(failure, signals)"]
```

**Idempotency invariant:** two concurrent calls with the same action payload
produce the same `idempotency_key`. The `UNIQUE` constraint on
`action_log.idempotency_key` makes the second insert a no-op. The X API has
no idempotency header on `POST /2/tweets`, so this guard is the only
defense against accidental double-posting.

**Shadow-mode short-circuit:** `STRAND_MODE=shadow` logs + marks `executed`
without calling X. That's what makes `pnpm smoke:shadow` fast and offline.

---

## 6. brainctl access model — two surfaces, one brain

```mermaid
flowchart LR
  subgraph GROK[Grok reasoning calls]
    REAS2[Reasoner]
    CONS2[Consolidator]
  end

  subgraph TS[TS-direct · src/clients/brain.ts]
    PERC2[Perceiver]
    ACT2[Actor]
  end

  subgraph BRAIN[brainctl]
    direction TB
    subgraph REMOTE[Remote MCP transport<br/>HTTP or SSE<br/>allowed_tools allowlist]
      direction TB
      RR[[READ_ALLOWLIST:<br/>memory_search · entity_search · entity_get ·<br/>event_search · context_search · tom_perspective_get ·<br/>policy_match · reason · infer_pretask · belief_get ·<br/>whosknows · vsearch ·<br/>temporal_*]]
      RC[[+ CONSOLIDATOR extras:<br/>reflexion_write · dream_cycle ·<br/>consolidation_run · gaps_scan ·<br/>retirement_analysis]]
    end
    subgraph LOCAL[Local stdio MCP<br/>src/clients/brain.ts]
      LT[[TS-only mutations:<br/>event_add · entity_observe ·<br/>memory_add · outcome_annotate ·<br/>policy_feedback · memory_promote ·<br/>entity_merge · belief_set · trust_calibrate ·<br/>batchReads]]
    end
    NEVER[/"NEVER EXPOSED to Grok:<br/>memory_add · memory_promote · entity_create ·<br/>entity_merge · event_add · belief_set ·<br/>policy_add · policy_feedback · budget_set ·<br/>trust_* · backup · quarantine_purge"/]
  end

  REAS2 -->|MCP tool config:<br/>REASONER_MCP_ALLOWLIST<br/>authorization header| RR
  CONS2 -->|CONSOLIDATOR_MCP_ALLOWLIST| RC
  RC --> RR

  PERC2 --> LT
  ACT2 --> LT

  LT -.->|writes| BRAIN_DB[(brain.db)]
  RR -.->|reads| BRAIN_DB
  RC -.->|reads + consolidation mutations| BRAIN_DB

  classDef warn fill:#450a0a,stroke:#ef4444,color:#fee2e2
  class NEVER warn
```

**Why stdio for TS, HTTP/SSE for Grok:**
- xAI remote-MCP spec rejects stdio. Grok MUST speak HTTP/SSE.
- Our TS process wants low-latency, zero-network brainctl calls. stdio to a
  spawned `brainctl mcp` subprocess is fastest.
- `require_approval` / `connector_id` are not supported by xAI — `allowed_tools`
  is the only gate. Hence the two allowlists are load-bearing security.

---

## 7. SQLite schema (ops layer — brain.db owns the semantic layer)

```mermaid
erDiagram
    action_log ||--o{ human_review_queue : "decision_id"
    action_log {
        int id PK
        text idempotency_key UK
        text decision_id
        text kind
        text payload_json
        real confidence
        real relevance
        text target_entity_id
        text mode "shadow|gated|live"
        text status "proposed|approved|rejected|executed|failed|reverted"
        text reasons_json
        text x_object_id
        text error_code
        text created_at
        text executed_at
        int duration_ms
    }
    cooldowns {
        text scope PK "target:userId | pair:a:b"
        text kind PK "any | actionKind"
        int until_at "ms epoch"
    }
    human_review_queue {
        int id PK
        text decision_id UK
        text payload_json
        text reasons_json
        text created_at
        text decided_at
        text decision "approved|rejected|expired"
    }
    post_embeddings {
        text tweet_id PK
        text text
        text embedding_json "swap for vector store at scale"
        text created_at
    }
    perceived_events {
        text id PK
        text kind "mention|timeline_post|dm"
        text payload_json
        int forwarded_to_brain "0|1"
        text created_at
    }
    dlq {
        int id PK
        text queue
        text payload_json
        text error
        int attempts
        text created_at
    }
    consolidator_runs {
        text id PK "ULID"
        text batch_id
        text status "queued|in_progress|completed|failed|partial"
        text created_at
        text completed_at
        text summary_json "{ changed, insights, gaps, retirements, failed_tasks }"
        text error
    }
    reasoner_runs {
        int id PK
        text tick_at
        text response_id
        text previous_response_id "null unless stuck-mid-thought"
        int candidate_count
        int tool_call_count
        text usage_json
        int cost_in_usd_ticks "1e-10 USD"
        int stuck_mid_thought "0|1"
    }
    rate_counters {
        text scope PK "global"
        text kind PK "actionKind"
        int window_ms PK
        int count
        int window_start "ms epoch"
    }
```

Indexes (all idempotent via `CREATE INDEX IF NOT EXISTS`):

| Table | Index | Purpose |
|---|---|---|
| action_log | status, kind, created_at, target_entity_id, decision_id | dashboards, dedup, per-target analysis, join to review queue |
| cooldowns | until_at | sweeper: find expired rows |
| post_embeddings | created_at | 7-day duplicate-text window |
| perceived_events | kind, forwarded_to_brain | forward-to-brain queue, per-kind metrics |
| human_review_queue | decided_at IS NULL | open-review fast path |
| consolidator_runs | status | poll sweep |
| reasoner_runs | tick_at, stuck_mid_thought | cost/quality dashboard, stuck-chain forensics |

brain.db carries the semantic layer (entities, memories, beliefs, reflexions,
temporal graph). strand.db is audit + ops only — no semantic claims live here.

---

## 8. Circuit breakers (not a diagram — a list you'll reach for at 3am)

Coded in Actor + the X client; monitored in brainctl via `policy_feedback`.

| Condition | Response |
|---|---|
| X `429` | Halt Actor 1 h; honor `x-rate-limit-reset`; alert. |
| X `429 UsageCapExceeded` (monthly) | Halt Actor 24 h; alert immediately; do NOT retry. |
| X `403` (duplicate content) | Terminal on that action. Log, no retry. |
| X `403 automated_behavior` | Trip master switch: halt all writes, flip to read-only, page operator. |
| Mention sentiment > 2σ negative vs 30d baseline | Halt outreach (reply/quote/dm); keep reads running. |
| `grokCall` throws | Reasoner returns `[]`; no `reasoner_runs` insert that tick. |
| Embedder load failure | `prefilterComposerText` refuses every call until restart. Refuse silent degradation. |
| Batch `failed` | `consolidator_runs.status='failed'`; error-level log; alert. Do NOT auto-retry. |
| brainctl MCP timeout (5 s per op) | `batchReads` surfaces per-op `{ ok:false, error:'timeout' }`; caller decides. |

---

## 9. Config surface (YAML, validated at boot)

| File | Schema | Role |
|---|---|---|
| `config/persona.yaml` | `PersonaConfigSchema` | handle, voice, topics, banned_topics, style_notes |
| `config/policies.yaml` | `PoliciesConfigSchema` | caps per day/hour, cooldowns, thresholds, diversity, review flags, ramp_multiplier |
| `config/seed-entities.yaml` | `SeedEntitiesConfigSchema` | watch_users, watch_topics, banned_users |
| `config/banned_exemplars.yaml` | freeform list | seed embeddings for prefilter similarity check |
| `.env` | `EnvSchema` (Zod) | secrets + runtime mode + model aliases |

Bad config is a fatal boot error — `process.exit(1)` with the Zod error tree.

---

## 10. What this architecture does NOT handle (honest list)

- **Backpressure.** Loops are unbounded intervals, not queues. A slow
  `reasonerTick` just skips the next tick (in-process timer), but if we move
  to BullMQ we need explicit concurrency caps per queue.
- **Multi-tenant.** One persona per deployment. `prompt_cache_key` has tenant
  in its shape for a reason, but the rest of the system hardcodes a single
  handle.
- **Follow / unfollow** is compile-gated behind `TIER`. Basic tier returns
  403 on the endpoint; `TIER=basic` keeps the variant out of live dispatch.
- **Home-timeline polling** on Basic tier eats the 10k/mo call cap for
  near-zero signal. Perceiver polls mentions; Grok's `x_search` handles
  topic/user discovery.
- **Media upload.** Chunked `POST /2/media/upload` (INIT/APPEND/FINALIZE/STATUS)
  is not yet wired. Action variants with `mediaIds` exist in the type system;
  the upload helper is a Phase 5 task.
- **Encrypted X Chat DMs.** Invisible to the API. DM reply-rate metrics
  under-measure — documented in dashboards, not addressed in code.

---

## 11. File → role cross-reference

| Path | Role |
|---|---|
| `src/index.ts` | Process entry: env validate → register shutdown → `start()` |
| `src/orchestrator.ts` | Loop scheduler + graceful shutdown |
| `src/config.ts` | Env + YAML loader + `effectiveCap` |
| `src/clients/x.ts` | X v2 wrapper: mentions, TL, DMs, execute(action) |
| `src/clients/grok.ts` | Responses API + Batch API + `grokCompose` + MCP tool builder |
| `src/clients/brain.ts` | stdio MCP client; TS-direct read + write surface |
| `src/loops/perceiver.ts` | X poll → `perceived_events` + brain.event_add |
| `src/loops/reasoner.ts` | `grokCall` + Zod parse + `reasoner_runs` |
| `src/loops/consolidator.ts` | Batch submit + poll + aggregate |
| `src/loops/actor.ts` | Idempotency + dispatch + rate inc + cooldown record + outcome annotate |
| `src/policy/index.ts` | 8-rule gate + typestate mint |
| `src/policy/{rateCaps,cooldowns,diversity,duplicates,topicalRelevance}.ts` | individual rules |
| `src/types/actions.ts` | ActionSchema + CandidateEnvelope + Candidate<state> brand |
| `src/util/prefilter.ts` | sync regex/topic gate + async embedding gate |
| `src/util/ratelimit.ts` | window-bucketed counters on SQLite |
| `src/util/idempotency.ts` | SHA-256 dedup key + decision id |
| `src/db/schema.sql` | ops schema (see §7) |
| `scripts/smoke-shadow.ts` | Phase 2 integration smoke |
| `scripts/replay-shadow.ts` | Policy regression replay |
| `scripts/ingest-followers.ts` | One-shot follower sync (tier-capped) |
| `scripts/oauth-setup.ts` | OAuth2 PKCE capture w/ refresh rotation |
| `scripts/bootstrap-memory.ts` | Seed brainctl with persona/policies/banned topics |

---

When you edit code, update this doc or delete the stale section. A wrong
diagram is worse than no diagram.
