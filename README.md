# Strand

Provider-agnostic agent harness. One unified CLI, a plan runner with LLM decomposition + reflection + retry, multi-agent spawn, an agentic tool loop with built-in primitives (fs/shell/http/git/brainctl) + desktop/computer use, persistent TaskGraphs, budget enforcement, typestate policy gate, BYOK credentials with OAuth refresh, and brainctl-backed long-term memory.

LLM: xAI · OpenAI-compatible (+ Ollama/Groq/Together/LM Studio) · Anthropic · Gemini. Pick with `LLM_PROVIDER`. Adapters translate to each provider's native wire format and declare capabilities — features degrade gracefully where unsupported.

## CLI at a glance

```bash
strand init                      # first-run wizard — pick provider, store key, write .env
strand doctor                    # preflight health check
strand run "summarize the README and commit a rewrite"   # one-shot agentic plan
strand tui                       # welcome splash · [d] live dashboard
strand cockpit                   # live operator cockpit for a pinned terminal
strand status                    # orchestrator + reasoner/consolidator summary
strand tasks list                # persisted TaskGraphs
strand tasks show <id>           # graph + steps + reflections
strand budget                    # configured + observed spend (last 24h)
strand cache                     # prompt-cache hit rates + drift warnings
strand tools list                # registered built-in tools
strand keys set XAI_API_KEY      # BYOK — write credential
strand oauth x                   # X OAuth 2.0 PKCE → atomic store write
strand config show               # effective resolved config
strand dev                       # boot orchestrator (watch)
strand smoke                     # integration smoke
```

Full help: `strand --help` (or `pnpm strand --help` in dev).

### Prompt cache hygiene

Most agent bills come from busted prefix caches — children and retries that change the reusable prefix. Strand optimizes for **shared-prefix, branch-at-the-tail**:

- `decompose` / `step` / `reflect` all use byte-stable static system prompts declared in `src/agent/prompts.ts`. Dynamic content (goals, tool lists, repo context) lives in **user** messages, never the system.
- Tool catalogs rendered to the LLM are sorted lexicographically so registration order can't bust the cache.
- Every call sets a stable `promptCacheKey`: `strand:plan:{decompose,step,reflect}:v1`, `strand:reasoner:v1`, `strand:consolidator:v1`, `strand:composer:<kind>:v1`.
- Anthropic adapter places `cache_control: {type:"ephemeral"}` breakpoints at the end of the shared system AND at the last message — the two-breakpoint pattern that covers shared-prefix reuse AND intra-loop continuation.
- Every adapter's `chat.call` log now includes `cache_ratio` + `prompt_cache_key` so you can watch for drift in real time.
- `strand cache` aggregates `reasoner_runs.usage_json` over a window, shows the hit rate, and flags drift when it drops below 30 % over 5 + ticks.

## Architecture

```
perceiver  ─▶  brainctl (MCP)  ◀─── grok (x_search, web_search, MCP tools)
                  ▲                              │
                  │                              ▼
actor ◀── policy gate (typestate) ◀──────── reasoner (candidates)
```

See `docs/ARCHITECTURE.md` for the full technical map (7 Mermaid diagrams, schema, cadence tables, circuit breakers). See `PLAN.md` for the phased build plan.

## Setup

### Fastest path (30 seconds)

```bash
pnpm install
pnpm strand init        # pick provider, paste key, .env written
pnpm strand doctor      # verify everything resolves
pnpm strand run "summarize README.md in 3 bullets"
```

`strand doctor` flags anything wrong (node version, native-module compile, missing creds, optional docker/brainctl). Only LLM creds and node ≥ 22 are required — everything else degrades gracefully.

### Manual setup

```bash
cp .env.example .env                       # base env
cp strand.config.example.yaml strand.config.yaml   # optional — one file for all knobs
pnpm install

# Pick ONE credential source:
#   (a) edit .env directly — STRAND_CREDENTIAL_STORE=env (default)
#   (b) pluggable file store — keys never touch .env:
#       export STRAND_CREDENTIAL_STORE=file
#       strand keys set XAI_API_KEY
#       strand keys set X_CLIENT_ID
#       strand keys set X_CLIENT_SECRET
#       strand keys list

strand oauth x              # X OAuth 2.0 PKCE → atomic token store write
strand dev                  # boot orchestrator (watch mode)
strand tui                  # live TUI
```

### Config file

`strand.config.yaml` consolidates mode / provider / credential store / budget defaults / agent limits / orchestrator cadences / tool workdir / X tier in one place. Resolution order: `--config <path>` → `./strand.config.yaml` → `~/.strand/config.yaml` → built-in defaults. Config merges **under** process env — explicit env vars always win.

### Bring-your-own-key (BYOK)

Strand resolves every credential through `src/auth/` — a pluggable `CredentialStore`. Pick your backend via `STRAND_CREDENTIAL_STORE`:

- **`env`** (default) — process env, matches historical behavior
- **`file`** — `~/.strand/credentials.json`, 0600 perms, atomic rename
- **`file+env`** — file wins on read; env is fallback
- **`encrypted-file`** — AES-256-GCM + scrypt KDF at rest. Requires `STRAND_CREDENTIAL_PASSPHRASE`. Zero new deps (Node's built-in `crypto`).
- **`encrypted-file+env`** — encrypted file wins; env is fallback
- **`keychain`** — OS-native (macOS Keychain / Linux Secret Service / Windows Credential Manager) via `@napi-rs/keyring` (optional dep — install with `pnpm add @napi-rs/keyring`)
- **`keychain+env`** — keychain wins; env is fallback
- **OAuth decorator** — wraps any base store, transparently refreshes provider tokens on access. X OAuth 2.0 PKCE is preregistered; `store.get("X_USER_ACCESS_TOKEN")` auto-refreshes within 60 s of expiry with atomic rotation of access + refresh + expiry.

#### Multi-tenant (`STRAND_TENANT`)

Set `STRAND_TENANT=acme` to namespace every credential key as `tenant:acme:<KEY>`. Different Strand processes (or requests, via `TenantScopedCredentialStore(base, tenantId)` directly) can share the same backing store without seeing each other's keys.

```bash
pnpm keys list                              # what's in the store
pnpm keys set OPENAI_API_KEY sk-…            # write
pnpm keys get OPENAI_API_KEY                 # read (echoed in cleartext)
pnpm keys delete OPENAI_API_KEY              # remove
pnpm keys refresh-oauth X_USER_ACCESS_TOKEN  # force OAuth refresh now
```

To plug a custom backend (Keychain, 1Password, HashiCorp Vault, database per tenant): implement `CredentialStore` and pass it into `llm({ credentials })`.

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

## Procedural skills

A **skill** is a markdown file with YAML front-matter (`.strand/skills/*.skill.md`) that Strand loads as a `Tool`. Calling the tool spawns a nested `runPlan` with the skill's body as the goal — cheap, recursive, byte-stable.

```bash
strand skills list              # both dirs, origin-annotated
strand skills show <name>       # resolved path + raw contents
strand skills add <name>        # interactive: write ./.strand/skills/<name>.skill.md
strand skills remove <name>     # delete (default project, --user for ~/.strand)
strand skills validate          # parse all, report YAML / schema errors
```

Project skills (`./.strand/skills/`) override user skills (`~/.strand/skills/`) on name collision. Every skill declares `sideEffects` (`none|local|external|destructive`), `requiresLive`, and `allowedTools`; the scoped registry for the nested run intersects with the skill's allowlist so a skill can never access tools its author didn't permit.

### Autonomous skill creation

`runPlan` can (optionally) ask the LLM whether a successful plan is worth promoting into a reusable skill. The hook is off by default. Turn it on per-call:

```ts
const result = await runPlan(ctx, "summarize any URL and write a report", {
  autoCreateSkill: {
    mode: "manual",                                   // "off" | "manual" | "auto"
    store: makeSqliteSkillProposalStore(),            // SqliteSkillProposalStore by default
    projectSkillsDir: "./.strand/skills",
  },
});
```

Invariants (safety is load-bearing here):

- **Pre-LLM gates**: plan must have `status: "completed"`, ≥ 2 completed steps, ≥ 1 tool call (all tunable via `minSteps` / `minToolCalls`).
- **Post-LLM gates**: proposed name matches `/^[a-z][a-z0-9_-]{2,39}$/` and never shadows a registered tool.
- **sideEffects escalation**: Strand walks the plan's used tools, looks up each one's registered `sideEffects`, and takes the max (`destructive > external > local > none`). If the LLM claimed the skill is safer than what the plan actually touched, Strand escalates the proposal doc — a skill that called `http_fetch` can never ship as `"none"`.
- **Auto-install gate**: `mode: "auto"` installs to disk only when resolved `sideEffects ∈ {none, local}` AND `!requiresLive`. Everything else — destructive, live, external — queues instead and waits for a human.

Review the queue:

```bash
strand skills pending list                 # default filter: status=pending
strand skills pending list -s installed    # or approved / rejected / installed
strand skills pending show <id>            # full doc + LLM reasoning
strand skills pending approve <id>         # write to ./.strand/skills (or --dir)
strand skills pending reject <id>          # mark rejected, no disk write
```

Proposals live in `agent_skill_proposals` (strand.db). The LLM call uses a byte-stable cache key (`strand:skills:propose:v1`) — the proposal prompt is reused across every plan, so only the per-plan user message is uncached.

## Non-negotiable

Read `CLAUDE.md`. The policy gate is not bypassable. DMs to non-mutuals: never. All DMs require human review during ramp-up.
