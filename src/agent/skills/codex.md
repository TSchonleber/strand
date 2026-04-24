---
name: codex
description: Delegate coding tasks to OpenAI Codex CLI
version: 1.0.0
triggers: ["coding", "implement", "fix", "generate", "scaffold"]
backend: cli-process
spawn_spec:
  cmd: codex
  args: ["exec", "--json"]
  parser: codex-exec
tools_allowed: [Read, Edit, Bash]
budget: { tokens: 50000, usdTicks: 2000000, wallClockMs: 300000 }
---

# Codex CLI

Delegate a coding task to OpenAI's Codex CLI agent.

## When to use

- The task requires generating, editing, or scaffolding code.
- You want to use OpenAI models for the subtask.
- The task is well-scoped and can run as a oneshot execution.

## Invocation

The cockpit spawns `codex exec --json "<task>"` for structured output.
The task description is passed as stdin in oneshot mode.

## Allowed tools

The subagent is restricted to: `Read`, `Edit`, `Bash`.

## Budget

Default: 50k tokens, $0.002 USD, 5 min wall clock. Child budget is
capped at half the parent's remaining budget on all dimensions.

## Output

Stdout is parsed as newline-delimited JSON when available. The parser
falls back to raw-text passthrough if the JSON format is unstable.
Events are normalized into CockpitEvent schema.

## Known risks

- `codex exec --json` output format is not fully stable. The parser
  includes a raw-text fallback for resilience.
- Version mismatches may change the JSON schema without notice. Monitor
  parser errors and fall back to raw-text if needed (kill switch S4).
