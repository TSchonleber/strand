# Strand

Autonomous X presence agent. Provider-agnostic LLM reasoning (xAI · OpenAI · Anthropic · Gemini), brainctl-backed long-term memory, X API for action, typestate-enforced policy gate between them.

Pick a provider with `LLM_PROVIDER` in `.env`. Loops call `llm().chat()` — adapters translate to each provider's native wire format and declare capabilities (structured output, MCP, server-side tools, batch, prompt caching) so features degrade gracefully where unsupported.

## Architecture

```
perceiver  ─▶  brainctl (MCP)  ◀─── grok (x_search, web_search, MCP tools)
                  ▲                              │
                  │                              ▼
actor ◀── policy gate (typestate) ◀──────── reasoner (candidates)
```

See `docs/ARCHITECTURE.md` for the full technical map (7 Mermaid diagrams, schema, cadence tables, circuit breakers). See `PLAN.md` for the phased build plan.

## Setup

```bash
cp .env.example .env
# Fill in XAI_API_KEY, X_CLIENT_ID, X_CLIENT_SECRET from Apple Notes

pnpm install
pnpm oauth:setup              # capture user OAuth refresh token
pnpm memory:bootstrap         # seed brainctl with persona + policies
pnpm dev                      # boot orchestrator in shadow mode
```

## Modes

Set `STRAND_MODE` in `.env`:
- `shadow` — reasoner proposes, no X writes
- `gated` — writes enabled, human review required per policy
- `live` — fully autonomous within caps

Start in `shadow` until 100 candidates reviewed and ≥80% agree with your manual labels.

## Scripts

- `pnpm dev` — orchestrator with watch
- `pnpm test` — vitest
- `pnpm typecheck` — tsc --noEmit
- `pnpm status` — last N events + last N actions from local DB
- `pnpm review` — walk through pending human-review candidates
- `pnpm shadow:replay` — replay candidate log against current policy for regression
- `pnpm smoke:shadow` — integration smoke (seeds 3 mentions, mocks xAI via MSW, asserts reasoner→gate cycle)

## Stack

- **TypeScript** strict
- **LLM** — pluggable via `LlmProvider` interface at `src/clients/llm/`. Default `xai` (grok-4.20-reasoning). Ship-time adapters: `openai` (+ Ollama, Groq, Together, LM Studio via baseURL), `anthropic` (claude-opus-4-7), `gemini` (gemini-2.5-pro). Switch with `LLM_PROVIDER` env
- **brainctl** as remote MCP — LLM pulls memory directly (where the provider supports MCP)
- **X API v2** — own-timeline reads + all writes only; external scouting via provider-native tools where available (xAI `x_search`, Anthropic `web_search`, Gemini `google_search`)
- **SQLite** for action log, idempotency, rate counters
- In-process intervals in dev; scheduler TBD when prod needs it

## Non-negotiable

Read `CLAUDE.md`. The policy gate is not bypassable. DMs to non-mutuals: never. All DMs require human review during ramp-up.
