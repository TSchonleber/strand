# Strand

Autonomous X presence agent. Grok-powered reasoning, brainctl-backed long-term memory, X API for action, typestate-enforced policy gate between them.

## Architecture

```
perceiver  ─▶  brainctl (MCP)  ◀─── grok (x_search, web_search, MCP tools)
                  ▲                              │
                  │                              ▼
actor ◀── policy gate (typestate) ◀──────── reasoner (candidates)
```

See `docs/PLAN.md` for the full build plan.

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

## Stack

- **TypeScript** strict
- **xAI Grok** via Responses API (OpenAI SDK with `baseURL` override) — `grok-4.20-reasoning` (dated `grok-4.20-0309-reasoning` in prod) for reasoning/consolidation, `grok-4-1-fast-non-reasoning` for composition/judging
- **brainctl** as remote MCP — Grok pulls memory directly
- **X API v2** — own-timeline reads + all writes only; external scouting goes through Grok's `x_search`
- **SQLite** for action log, idempotency, rate counters
- **BullMQ/Redis** in prod, in-process intervals in dev

## Non-negotiable

Read `CLAUDE.md`. The policy gate is not bypassable. DMs to non-mutuals: never. All DMs require human review during ramp-up.
