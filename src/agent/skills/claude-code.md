---
name: claude-code
description: Delegate coding tasks to Claude Code CLI
version: 1.0.0
triggers: ["coding", "refactor", "review", "PR", "debug", "implement"]
backend: cli-process
spawn_spec:
  cmd: claude
  args: ["-p", "--output-format", "stream-json", "--verbose"]
  parser: claude-code-stream
tools_allowed: [Read, Edit, Bash, Write]
budget: { tokens: 50000, usdTicks: 2000000, wallClockMs: 300000 }
---

# Claude Code

Delegate a coding task to Claude Code running as a CLI subprocess.

## When to use

- The task requires reading, editing, or creating files in a repository.
- The task involves debugging, refactoring, or implementing features.
- You need a capable coding agent with file system and shell access.

## Invocation

The cockpit spawns `claude -p "<task>"` with `--output-format stream-json`
for structured streaming output. In BYOK (api_key) mode, `--bare` is
added automatically for fastest startup and lowest overhead. In
`oauth_external` mode, `--bare` is never passed (hard constraint #7).

## Allowed tools

The subagent is restricted to: `Read`, `Edit`, `Bash`, `Write`.
Additional tools can be granted per-spawn via `--allowedTools`.

## Budget

Default: 50k tokens, $0.002 USD, 5 min wall clock. Child budget is
capped at half the parent's remaining budget on all dimensions.

## Output

Stdout is parsed as newline-delimited JSON (`stream-json` format).
Events are normalized into CockpitEvent schema:
- Content deltas -> `subagent.event` kind `stdout`
- System/retry notices -> `subagent.event` kind `status`
- Terminal result -> `subagent.end` with cost metadata

## Notes

- `--max-turns 10` is a sensible default for bounded tasks.
- `--max-budget-usd 2.00` prevents runaway spend on a single delegation.
- Interactive mode (tmux wrapping) is planned but not yet implemented.
