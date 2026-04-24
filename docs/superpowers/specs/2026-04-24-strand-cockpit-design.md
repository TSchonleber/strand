# Strand Cockpit Redesign — Design Spec

**Date:** 2026-04-24
**Author:** Terrence (via Claude Opus 4.7 brainstorming)
**Status:** Approved for implementation plan
**Audience:** Codex (team lead), 4 Devin agents, 1 Claude Code agent

---

## Executive summary

Replace the current gamified Strand cockpit with a chat-first, provider-agnostic agent harness. The existing X/Twitter engine (Perceiver / Reasoner / Actor / Consolidator) keeps running as a registered background loop; the cockpit stops being a Twitter monitor and becomes a generic operator chat interface with pluggable LLM providers, multi-backend subagent spawning, and a self-curating skill lifecycle.

Architecture reference: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). Where hermes has solved the same problem cleanly, Strand copies the pattern verbatim and cites it.

---

## Cross-cutting principle: LEAN BY DEFAULT

Every token in Strand's own runtime costs the operator money. The cockpit is the operator's *interface to agents*, not an agent itself — it should add the smallest possible context footprint on top of the user's prompt.

**Enforced everywhere:**
- No skill bodies in the system prompt. Skills are retrieved JIT (top-K=3 by default, configurable down to 0).
- No background-loop telemetry in chat context. Systems drawer is off by default.
- Subagents default to `--bare` + minimal `--allowedTools` when the auth mode permits (see hard constraint #7).
- Reflexion judge defaults to the cheapest capable model (Haiku / GPT-4o-mini / Grok-4-fast). Never the reasoner.
- Context compaction default flips from `noop` → `summarizing` (`thresholdRatio: 0.75`, `keepTailTurns: 8`, `summarizerMaxOutputTokens: 800`).
- Event schema is lean — chunks are byte-sized, no giant base64 payloads through the renderer protocol.
- Every provider call logs `usage.{input,cached,output}_tokens` + prompt_cache_key. Unused cache = bug.

If a feature adds context weight to the main chat without a direct operator-visible benefit, it's wrong by default.

---

## Hard constraints (non-negotiable)

These are contracts every stream owner tests against, not prose to read once.

1. **Policy-gate preservation.** Any chat-driven action that maps to an X/Twitter action kind MUST still flow through the existing `Candidate<Approved>` typestate gate in `src/policy/index.ts`. Subagents propose `Candidate<Unchecked>`; only the gate mints `Approved`. Enforced at compile time — TS should refuse a bypass path. Property tests in S1.

2. **Renderer protocol is pinned in §4 of this spec.** Breaking changes bump the `X-Cockpit-Protocol` header major version. Ink and Web renderers consume the identical schema. Schema drift = P0 bug.

3. **`oauth_external` credential reuse is local-only; `oauth_device_code` works anywhere.** BYOK works anywhere. The auth picker tells the user which modes are available based on whether the cockpit is running on the same machine as their logged-in `claude` / `codex` / `gemini` CLI.

4. **Anthropic "OAuth-external" mode carries a billing warning.** Per open hermes-agent issue #12905, Anthropic routes third-party OAuth clients to the `extra_usage` billing pool, which is empty for most users. The cockpit surfaces this inline before the first call. No silent fallback fiction.

5. **No implicit activation from environment variables.** The presence of `CLAUDE_CODE_OAUTH_TOKEN` in the environment does NOT auto-activate the Anthropic provider. The user must explicitly pick a provider in the first-run flow or via `/auth`. Prevents silent token spend.

6. **Skill retirement is queued, not silent.** v1 ships with auto-retire proposals landing in a review feed; user approves with one click. Flip to silent after usage data validates the signal.

7. **Claude Code handling contract (`--bare` gotcha).** Bare mode skips OAuth and requires `ANTHROPIC_API_KEY`. The `cli-process` backend's Claude Code parser never passes `--bare` when the user's auth mode is `oauth_external`. In BYOK-Anthropic mode, `--bare` is the **default** for subagent spawns (fastest startup, lowest token overhead) — operator can opt in to full-context mode per-spawn.

8. **Lean budget defaults.** Default budgets per cockpit session: `tokens: 50_000`, `usdTicks: 2_000_000` ($0.002), `wallClockMs: 300_000`, `toolCalls: 40`. Subagent spawns get half their parent's remaining budget by default. Operator can raise per-session; the default is set to yell early on bloat.

---

## §1 — Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  Cockpit Core (headless, no UI imports)                     │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Transcript    │  │ Subagent     │  │ Skill Lifecycle  │  │
│  │ event bus     │  │ registry     │  │ (c + iii)        │  │
│  └───────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Provider      │  │ Policy gate  │  │ Loop registry    │  │
│  │ router        │  │ (untouched)  │  │ (X engine =      │  │
│  │               │  │              │  │  one entry)      │  │
│  └───────────────┘  └──────────────┘  └──────────────────┘  │
└──────────┬──────────────────────┬───────────────────────────┘
           │ Renderer Protocol    │ Renderer Protocol
           │ (pinned SSE schema)  │
           ▼                      ▼
    ┌──────────────┐        ┌──────────────┐
    │ Ink renderer │        │ Web renderer │
    │ (terminal)   │        │ (Vite+Hono)  │
    └──────────────┘        └──────────────┘
```

**Two invariants:**
- Core never imports from either renderer.
- Both renderers consume the same event schema.

---

## §2 — Provider / subagent / skill split

This is the structural refactor that everything else depends on. The hermes codebase demonstrates the split; Strand adopts it.

| Layer | What it is | Examples |
|---|---|---|
| **Provider** | Chat completions source — where tokens come from | `anthropic-api`, `openai-api`, `xai-api`, `gemini-api`, `openai-compat` (Ollama / LM Studio / OpenRouter / Together) |
| **Subagent** | Delegatable worker the main agent spawns | `internal`, `cli-process` (generic), `ssh` |
| **Skill** | Markdown instruction telling the agent *when* to use a provider / tool / subagent | `claude-code.md`, `codex.md`, `pr-review.md`, arbitrary new skills |

**Consequences:**
- `claude` and `codex` CLIs are NOT LLM providers. They are skills that invoke the `cli-process` subagent backend. One generic backend, unlimited CLI skills.
- Adding a new CLI (Aider, Cline, gpt-engineer, whatever ships next) = write a skill, not a backend.
- The existing `src/clients/llm/` stays the home for provider adapters. Subagents live in `src/agent/`.

---

## §3 — Auth & provider model

Reference implementation: `hermes_cli/auth.py`.

### Auth types

| Auth type | Mechanism | Host constraint |
|---|---|---|
| `api_key` | User-supplied key, read from env or Strand's encrypted store | Any |
| `oauth_device_code` | Real PKCE device-code flow. POST to issuer's `/deviceauth/usercode`, show user a URL + code, poll, exchange at `/oauth/token`. Strand manages refresh. | Any |
| `oauth_external` | Read credentials another tool wrote to disk (`~/.claude/.credentials.json`, `~/.qwen/oauth_creds.json`, etc.) | Local only |

### Per-provider plan

**Lean list.** v1 ships with exactly these providers. No Kimi / z.ai / MiniMax / DeepSeek / etc. in the first cut — the `openai-compat` entry already covers any OpenAI-API-compatible endpoint via `baseURL`, which handles 90% of future additions without new adapter code.

| Provider | Primary | Secondary | Notes |
|---|---|---|---|
| Anthropic | `api_key` (`ANTHROPIC_API_KEY`) | `oauth_external` from Claude Code creds | Secondary shows billing warning (hard constraint #4) |
| OpenAI | `api_key` (`OPENAI_API_KEY`) | `oauth_device_code` against `auth.openai.com` (genuine PKCE — see hermes `_codex_device_code_login`) | Device-code works on any host |
| xAI | `api_key` (`XAI_API_KEY`) | — | Removed as the default — user picks |
| Gemini | `api_key` (`GEMINI_API_KEY`) | `oauth_external` from gemini-cli creds | |
| openai-compat | `api_key` + `baseURL` | — | Catches Ollama, LM Studio, OpenRouter, Together, and the long tail — no per-vendor adapter |

### Device-code flow reference (OpenAI)

```
POST https://auth.openai.com/api/accounts/deviceauth/usercode
  body: { client_id }
  → { user_code, device_auth_id, interval }

# Show user: open https://auth.openai.com/codex/device, enter code
# Poll:
POST https://auth.openai.com/api/accounts/deviceauth/token
  body: { device_auth_id, user_code }
  → 200 { authorization_code, code_verifier }  OR  403/404 (not yet)

POST https://auth.openai.com/oauth/token
  body (form): { grant_type: authorization_code, code, redirect_uri,
                 client_id, code_verifier }
  → { access_token, refresh_token, id_token, expires_in }
```

Max wait 15 minutes. Poll interval ≥ 3s. Port hermes's implementation directly.

### Auth store shape

```jsonc
// ~/.strand/auth.json
{
  "active_provider": "openai",
  "providers": {
    "openai":    { "auth_type": "oauth_device_code", "tokens": {...}, "expires_at": "..." },
    "anthropic": { "auth_type": "api_key", "source": "env:ANTHROPIC_API_KEY" }
  },
  "suppressed_sources": { "anthropic": ["cli_credentials"] }
}
```

**Rules** (verbatim from hermes):
1. No implicit use of external credentials — see hard constraint #5.
2. `suppressed_sources` lets users blacklist a specific discovery path per provider.
3. Single-writer file lock on the auth store during refresh.

### First-run UX

No default. Picker shows the provider table with inline "how this will be billed" copy. Choice persists to `~/.strand/auth.json` + `~/.strand/profile.json`. Switching is a slash command: `/model anthropic claude-sonnet-4-6`.

**`strand.config.yaml`:** the `llm.provider: xai` default is removed. Explicit selection required or cockpit errors with a clear picker prompt.

### Language in the UI

Label the `oauth_external` entries honestly: *"Use my Claude Pro/Max subscription (local only) — may bill as metered API usage, see notice"*. Avoid the word "OAuth" alone, since the semantics vary per provider.

---

## §4 — Cockpit substrate

### Packages

```
src/cockpit/core/      ← no UI imports; pure TypeScript
src/cockpit/ink/       ← depends on core only
src/cockpit/web/       ← depends on core only; Vite + Hono, served by `strand dev`
```

### Core exports

- `Transcript` — append-only event log (SQLite-backed, keyed by session UUID). Survives restarts.
- `ChatController` — takes user input, routes to provider, emits events.
- `SubagentRegistry` — tracks spawned workers (see §5).
- `SkillRegistry` — see §6.
- `ProviderRouter` — picks the right provider per the auth/profile from §3.
- `EventBus` — in-process `EventEmitter<CockpitEvent>`; renderers subscribe.

### Renderer protocol (PINNED)

```ts
type CockpitEvent =
  | { t: 'transcript.append', sessionId: string, message: Message }
  | { t: 'transcript.delta',  sessionId: string, messageId: string, chunk: string }
  | { t: 'tool.start',        sessionId: string, callId: string, name: string, args: unknown }
  | { t: 'tool.progress',     sessionId: string, callId: string, chunk: string }
  | { t: 'tool.end',          sessionId: string, callId: string, ok: boolean, result?: unknown }
  | { t: 'subagent.spawn',    subagentId: string, backend: SubagentBackend, parentSessionId: string }
  | { t: 'subagent.event',    subagentId: string, kind: 'stdout'|'stderr'|'status', chunk: string }
  | { t: 'subagent.end',      subagentId: string, ok: boolean, exit?: number }
  | { t: 'skill.proposal',    proposalId: string, kind: 'draft'|'retire', payload: SkillProposal }
  | { t: 'skill.decision',    proposalId: string, decision: 'accepted'|'rejected', by: 'user'|'auto' }
  | { t: 'provider.switch',   from: ProviderId, to: ProviderId }
  | { t: 'policy.gate',       candidateId: string, result: 'approved'|'rejected', reason?: string }
  | { t: 'budget.warn',       sessionId: string, dimension: 'tokens'|'usd'|'wallclock'|'toolCalls', used: number, cap: number }
  | { t: 'error',             sessionId?: string, code: string, message: string };
```

- **Ink** subscribes to the in-process `EventBus` directly.
- **Web** connects via SSE at `GET /events` (same schema, serialized).
- Both render **from the event stream**, never query mutable state.
- **Version header:** `X-Cockpit-Protocol: 1` on the SSE stream. Bumping it is a major change; renderers warn on mismatch.

### Transport details

- Web renderer served by `strand dev` (Vite + Hono); production build via `strand web-build` → `dist/web/`.
- SSE endpoints: `GET /events` (event stream), `POST /input` (user input), `POST /commands/:slash` (slash commands).
- Auth to the local web server: loopback-only, random token written to `~/.strand/cockpit.token`, passed via header. Prevents other local processes from snooping.

---

## §5 — Subagent spawn model

### Unified interface

```ts
interface Subagent {
  id: string;
  backend: 'internal' | 'cli-process' | 'ssh';
  spawn(spec: SpawnSpec): Promise<SubagentHandle>;
}

interface SubagentHandle {
  send(input: string): Promise<void>;     // for interactive (tmux / stdin)
  events: AsyncIterable<CockpitEvent>;    // normalized into core's event schema
  status(): Promise<SubagentStatus>;
  cancel(): Promise<void>;
  budget: BudgetTracker;                  // inherited cap, child ≤ parent
}
```

### Backends

| Backend | Implementation | Use case |
|---|---|---|
| `internal` | Wrap existing `src/agent/spawn.ts`. Shares memory (brainctl), policy gate, provider router. | Cheap in-process delegation; capability-limited sub-agents |
| `cli-process` | Generic. Takes `{ cmd, args, mode: 'oneshot'\|'interactive', parser: StreamParser }`. Oneshot pipes stdin/stdout; interactive wraps in `tmux` (hidden from user). Ships with parsers for `claude -p --output-format stream-json`, `codex exec --json`, and raw-text passthrough. | `claude`, `codex`, any future CLI agent |
| `ssh` | Wrap existing `src/agent/executor-ssh.ts`. | Remote shell, future remote worker fleet |

### Budget inheritance

Every subagent inherits ≤ parent budget on all four dimensions: `tokens`, `usdTicks`, `wallClockMs`, `toolCalls`. Child can't exceed parent's remaining. Enforced at spawn, not trust-the-child.

### Concurrency + depth caps (from hermes `tools/delegate_tool.py`)

- `maxDepth: 3` — cockpit (0) → agent (1) → subagent (2) → grand-subagent (3), beyond rejected.
- `maxConcurrentChildren: 3` per parent (configurable via `strand.config.yaml`).
- Heartbeat every 30s during long delegations.
- Stale subagent auto-cancelled at 10 minutes of no progress (override-able per-spawn).

### Chat-driven spawning

Slash commands in cockpit chat:
- `/spawn claude <task>` — delegates to Claude Code skill
- `/spawn codex <task>` — delegates to Codex skill
- `/spawn internal <task>` — internal Strand subagent
- `/spawn ssh <host> <task>` — remote worker

Each spawned worker gets its own tab (web) / pane (Ink). Worker events stream into the parent transcript AND the worker's own sub-transcript.

### Claude Code parser (implementation note for S4)

Ship oneshot-mode default. Example invocation:

```bash
claude -p "<task>" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --max-turns 10 \
  --allowedTools "Read,Edit,Bash" \
  --max-budget-usd 2.00
```

Parse newline-delimited JSON. Map `stream_event` → `subagent.event` kind `stdout`. Map `system/api_retry` → `subagent.event` kind `status`. Terminal `result` event carries `session_id`, `num_turns`, `total_cost_usd` — emit as `subagent.end` payload. For interactive mode, wrap in tmux per hermes Claude Code skill (handle trust dialog + bypass-permissions dialog as specified in that skill).

### Policy gate preservation

Subagents proposing X/Twitter actions emit `Candidate<Unchecked>` — the gate in `src/policy/index.ts` is the only code path that can mint `Candidate<Approved>`. Subagents cannot import the gate; TS refuses the bypass at compile time. Hard constraint #1.

---

## §6 — Skill lifecycle

### Storage (option "c": markdown + SQLite)

```
src/agent/skills/*.md        ← human-readable, git-tracked, frontmatter spec
data/skills.sqlite           ← executable record: usage_count, success_count,
                              token_cost_p50/p95, last_used_at, trust_score,
                              triggers[], supersedes[], status
                              (active | retired | draft | queued_draft | queued_retire)
```

### Frontmatter shape

```yaml
---
name: claude-code
description: Delegate coding tasks to Claude Code CLI
version: 1.0.0
triggers: ["coding", "refactor", "review", "PR"]
backend: cli-process
spawn_spec:
  cmd: claude
  args: ["-p", "--output-format", "stream-json", "--verbose"]
  parser: claude-code-stream
tools_allowed: [Read, Edit, Bash, Write]
budget: { tokens: 50000, usdTicks: 2000000, wallClockMs: 300000 }
---
```

### Evolution loop (option "iii": reflexion + usage)

1. **Post-task reflexion** — after every completed task, a lightweight judge model reads the transcript and emits 0-N proposals: `{ kind: 'draft'|'retire', rationale, proposed_frontmatter? }`.
2. **Usage metrics** tick on every skill invocation (success, latency, token cost, user-aborted).
3. **Nightly scorer** (on the consolidator schedule):
   - `retire` candidate = hit-rate < 0.15 OR (success-rate < 0.5 AND n ≥ 10) OR (superseded by a higher-scoring skill on same triggers).
   - `draft` candidate = reflexion flagged AND ≥3 sessions exhibited the same pattern AND no active skill matches triggers.
4. **All proposals queue.** Cockpit surfaces a "Skill Review" feed. One-click accept/reject. Rejection remembered — same proposal won't re-queue for 30 days.
5. **Audit trail.** Every accept/reject logged to brainctl as a `decision` event with rationale.

### brainctl integration

Skills are a memory category. `skill` joins the existing categories (`convention | decision | environment | identity | integration | lesson | preference | project | user`). This reuses:
- W(m) trust gate
- Retirement analysis (the nightly scorer IS `retirement_analysis` filtered to `category=skill`)
- Labile-window rescue
- Trust decay

### Token-bloat reduction (the actual ask)

- Skills are NOT dumped into the system prompt.
- Skills retrieved JIT via trigger-match against user's current turn. Top-K (default 3) included.
- A skill's markdown body is the full instruction; never pasted inline unless match score clears a threshold.
- Retired skills removed from retrieval index same minute they're approved.
- `/skills` slash command lists active + queued + retired-with-un-retire.

---

## §7 — Gamified panel disposition

- **Default `strand` entry point** → drops user into the chat cockpit (web or Ink, user's pick on first run, persists).
- **Legacy panels** accessible via `strand tui --classic` or `/classic`. Zero loss, just not the default.
- **Twitter engine** keeps running when credentials + policy are configured. In the cockpit, it's a registered background subagent — its own tab emitting status events. Chat with the operator without reading per-tweet telemetry.
- **Systems telemetry** that used to live in gamified panels now flows into a collapsible right-rail "Systems" drawer — off by default. Keeps chat context clean.

---

## §8 — Workstream decomposition

**Ownership principle:** Claude Code takes the TS-hardest seats (typestate, policy gate, core event schema). Devins take web / adapters / storage / parallelizable surface work.

| Stream | Owner | Scope | Depends on |
|---|---|---|---|
| **S0 — Spec + scaffolding** | Codex (team lead) | Read this spec. Scaffold `src/cockpit/core/` with the §4 event schema. Land empty package skeletons. Stub `SubagentHandle` + `Subagent` interfaces. Set up CI matrix. | — |
| **S1 — Cockpit core + policy-gate preservation** | **Claude Code** | Implement `Transcript`, `EventBus`, `ChatController`, `ProviderRouter`. Prove any chat-driven X-engine action still compiles through `Candidate<Approved>`. Property tests enforcing hard constraint #1. | S0 |
| **S2 — Auth adapters + provider registry** | Devin-1 | BYOK for anthropic/openai/xai/gemini + `openai-compat`. PKCE device-code for OpenAI. `oauth_external` reader for `~/.claude/.credentials.json` + gemini-cli creds. `~/.strand/auth.json` store with single-writer lock. Picker UI wiring. | S0 |
| **S3 — Web cockpit renderer** | Devin-2 | Vite + Hono app served by `strand dev`. SSE consumer rendering §4 schema. Chat UI + subagent tabs + slash commands + `/skills` review feed. Tailwind + shadcn/ui. | S1 partial (schema + stub events) |
| **S4 — Subagent backends + seed skills** | Devin-3 | `cli-process` backend with `claude -p` + `codex exec` parsers. tmux wrapping for interactive. Seed skills: `claude-code`, `codex`, `pr-review` (port from hermes). Budget inheritance + caps. | S1 |
| **S5 — Skill lifecycle + brainctl integration + Ink renderer** | Devin-4 | `data/skills.sqlite` schema. Usage metric hooks. Reflexion judge. Nightly scorer. Queue + review UI wiring. brainctl `skill` category registration. Ink renderer for the "classic"-preserving path. | S1, S4 seed skills |

### Integration checkpoints (Codex enforces, not time-boxed — flow-boxed)

Agents work fast. These are gate conditions, not days. Codex holds the green flag between each one.

1. **Spec-read gate.** S0 landed, event schema frozen in code. All agents initial the sign-off at the bottom of this spec. Nobody writes feature code until this gate passes.
2. **Alive gate.** S1 + S2 land a streaming BYOK chat in Ink. If any provider's streaming response doesn't render into the Ink transcript, the event schema has a bug — fix before anything else ships. This is the single highest-value checkpoint.
3. **Parity gate.** S3 web cockpit renders the same schema. Parity test: identical event stream → identical transcript in Ink and Web. Divergence = P0.
4. **Spawn gate.** S4 `/spawn claude` and `/spawn codex` both complete a oneshot task end-to-end with streamed output into the cockpit transcript. `--bare` default path verified. Budget inheritance verified (child can't exceed parent remaining).
5. **Skill gate.** S5 scores a low-hit skill below threshold, emits a `queued_retire` proposal, operator approves in the review UI, skill drops out of the retrieval index. Same path for `queued_draft`.
6. **Cutover gate.** Old TUI moves to `strand tui --classic`. Default `strand` enters chat cockpit. `strand.config.yaml` example updated (no default provider). Release branch opened.

### Kill switches

- **S2 Anthropic-OAuth-external** → `extra_usage` bug: ship with warning banner, fall back to BYOK. Don't block sprint on Anthropic's billing behavior.
- **S4 `claude -p` parser** → version-mismatch-unreliable: fall back to raw-text parser, log, proceed.
- **S5 reflexion judge** → costs > $1/session: disable by default, keep queue + manual `/skill propose` only.

### Test matrix (minimum)

- **Core** — property test: no X-engine action reaches actor without `Candidate<Approved>`.
- **Auth** — device-code flow against openai (mocked token endpoint in CI).
- **Renderer parity** — record event stream from a scripted chat, replay through Ink and Web, assert identical transcript state.
- **Subagent budget** — spawn child with 50% of parent budget, burn 60% of child quota, assert child aborted, parent proceeds.
- **Skill lifecycle** — seed low-hit skill, tick usage below threshold, run scorer, assert `queued_retire` proposal emitted.

---

## References

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — primary reference implementation.
  - `hermes_cli/auth.py` — provider registry, device-code flow, auth store.
  - `tools/delegate_tool.py` — subagent spawn conventions.
  - `skills/autonomous-ai-agents/claude-code/SKILL.md` — Claude Code wrapping pattern.
  - `skills/autonomous-ai-agents/codex/SKILL.md` — Codex wrapping pattern.
  - Issue [#12905](https://github.com/NousResearch/hermes-agent/issues/12905) — Anthropic OAuth `extra_usage` routing.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) — flags, output formats, session management.
- [OpenAI device authorization](https://auth.openai.com/codex/device) — the endpoint users enter their device code at.
- Strand `CLAUDE.md` — existing project non-negotiables (policy gate, X API tier reality, Twitter engine architecture).
- Strand `docs/ARCHITECTURE.md` — existing architecture to preserve.

---

## Sign-off

Every stream owner acknowledges they've read this spec by appending their name + date below before writing code.

- [ ] Codex (team lead)
- [ ] Claude Code
- [ ] Devin-1
- [ ] Devin-2
- [ ] Devin-3
- [ ] Devin-4
