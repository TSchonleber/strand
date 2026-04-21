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

## Computer-use sandbox (DockerExecutor)

Strand's agentic loop can route provider-native `computer`, `bash_20250124`, and `text_editor_20250124` tool calls to a `ComputerExecutor`. The default is `NoopExecutor` (logs intent, does nothing). For real side effects, use `DockerExecutor`, which drives a containerized Xvfb + fluxbox desktop via `xdotool` and `scrot`.

### Build the sandbox image

```bash
docker build -t strand-sandbox:latest src/agent/docker-image
```

The image includes Xvfb, fluxbox, x11vnc (port 5900, no auth — isolate the container), xdotool, scrot, ffmpeg, and bash/coreutils. Entry point starts the display and a window manager, then blocks so `docker exec` can attach commands.

### Use it

```ts
import { DockerExecutor, runAgenticLoop } from "@/agent";

const executor = new DockerExecutor({
  image: "strand-sandbox:latest",
  containerName: "strand-sandbox",
  workdir: "/tmp/strand-work",
  autoStart: true,          // pull + run on first action
  defaultTimeoutMs: 30_000,
});

// After you have verified the container has no secrets mounted, no host
// network, and nothing else worth caring about on the filesystem:
executor.markSafe();

await runAgenticLoop({
  provider,
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "open a browser and go to example.com" }],
  executor,
});

await executor.stop();
```

### Safety

- `executor.safe` starts `false`. Policy code that gates on `safe === true` must refuse to run the executor until the operator has explicitly called `markSafe()`.
- Every action is logged via `log.info({ svc: "exec", exec: "docker", op, args })`.
- Arguments go through `execFile` as argv — no shell interpolation, no user-controlled strings fed into bash.
- `bash()` caps commands at 16KB input and truncates stdout at 64KB.
- Run the container with `--network=none` (or an isolated network) when in gated/live modes. Never mount secrets. Never share the host Docker socket.

### VNC observation (optional)

Publish port 5900 only when you want to watch (and only behind a trusted network — the entrypoint disables VNC auth):

```bash
docker run --rm -d --name strand-sandbox -p 127.0.0.1:5900:5900 strand-sandbox:latest
# then point a VNC client at vnc://127.0.0.1:5900
```

## Non-negotiable

Read `CLAUDE.md`. The policy gate is not bypassable. DMs to non-mutuals: never. All DMs require human review during ramp-up.
