---
name: pr-review
description: Review a pull request for correctness, security, and style
version: 1.0.0
triggers: ["review", "PR", "pull request", "code review"]
backend: cli-process
spawn_spec:
  cmd: claude
  args: ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "5"]
  parser: claude-code-stream
tools_allowed: [Read, Bash]
budget: { tokens: 30000, usdTicks: 1500000, wallClockMs: 180000 }
---

# PR Review

Review a pull request for correctness, security, and performance issues.

## When to use

- A pull request needs review before merge.
- You want an automated first pass on code quality.
- The operator asks you to review changes in a branch or PR.

## Invocation

The cockpit spawns Claude Code with a review-focused prompt. The task
should include the PR URL, branch name, or diff context. The subagent
reads the relevant files and provides structured feedback.

## Allowed tools

Read-only: `Read` for file inspection, `Bash` for git commands
(`git diff`, `git log`, `git show`). No write tools.

## Budget

Tighter than general coding: 30k tokens, $0.0015 USD, 3 min wall clock.
Reviews should be fast and focused.

## Review checklist

The subagent should evaluate:
1. **Correctness** — does the code do what it claims?
2. **Security** — no exposed secrets, injection vectors, or auth bypasses.
3. **Performance** — no N+1 queries, unbounded loops, or memory leaks.
4. **Style** — follows existing conventions (skip nitpicks).

## Output

Structured review comments normalized through the Claude Code stream
parser into CockpitEvent schema.
