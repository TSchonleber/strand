import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * CLI black-box tests — spawnSync'd tsx subprocess against a fresh DB.
 *
 * We don't test `strand run` (requires a live LLM) or `strand dev` (long-running).
 * Focus: subcommand plumbing, exit codes, help text, config validation, and
 * read-only commands that work on an empty DB.
 */

const CLI = resolve(process.cwd(), "src/cli/index.ts");

interface RunOpts {
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
}

function runCli(
  args: string[],
  opts: RunOpts = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOG_LEVEL: "fatal",
      XAI_API_KEY: "t",
      X_CLIENT_ID: "t",
      X_CLIENT_SECRET: "t",
      ...opts.env,
    },
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.input ? { input: opts.input } : {}),
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe("strand CLI", () => {
  let tmpDir: string;
  let tmpDb: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "strand-cli-"));
    tmpDb = join(tmpDir, "strand.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("`--help` lists all subcommands", () => {
    const { code, stdout } = runCli(["--help"]);
    expect(code).toBe(0);
    for (const sub of [
      "run",
      "tui",
      "status",
      "review",
      "tasks",
      "budget",
      "tools",
      "keys",
      "oauth",
      "config",
      "dev",
      "smoke",
    ]) {
      expect(stdout).toContain(sub);
    }
  });

  it("`tools list` prints the default tool catalog", () => {
    const { code, stdout } = runCli(["tools", "list"]);
    expect(code).toBe(0);
    expect(stdout).toContain("fs_read");
    expect(stdout).toContain("shell_bash");
    expect(stdout).toContain("git_status");
    expect(stdout).toContain("brain_memory_search");
    // destructive tools are gated behind --enable-destructive
    expect(stdout).not.toContain("fs_write");
  });

  it("`tools list --enable-destructive` includes fs_write and git_commit", () => {
    const { code, stdout } = runCli(["tools", "list", "--enable-destructive"]);
    expect(code).toBe(0);
    expect(stdout).toContain("fs_write");
    expect(stdout).toContain("git_commit");
  });

  it("`config show` dumps YAML with default mode `shadow`", () => {
    const { code, stdout } = runCli(["config", "show"]);
    expect(code).toBe(0);
    expect(stdout).toContain("mode: shadow");
    expect(stdout).toContain("provider: xai");
  });

  it("`config validate --file` on a missing path exits 1", () => {
    const { code, stderr } = runCli(["config", "validate", "--file", "/does/not/exist"]);
    expect(code).toBe(1);
    expect(stderr).toContain("failed to parse");
  });

  it("`config validate --file` on a malformed config exits 1 with zod tree", () => {
    const bad = join(tmpDir, "bad.yaml");
    writeFileSync(bad, "mode: notarealmode\n");
    const { code, stderr } = runCli(["config", "validate", "--file", bad]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid strand config");
  });

  it("`config validate --file` on a good config exits 0", () => {
    const good = join(tmpDir, "good.yaml");
    writeFileSync(good, "mode: gated\nllm:\n  provider: xai\n");
    const { code, stdout } = runCli(["config", "validate", "--file", good]);
    expect(code).toBe(0);
    expect(stdout).toContain("ok:");
  });

  it("`tasks list` on an empty DB prints `no tasks`", () => {
    const { code, stdout } = runCli(["tasks", "list"], {
      env: { DATABASE_PATH: tmpDb },
      cwd: process.cwd(),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("no tasks");
  });

  it("`tasks show <missing-id>` exits 1", () => {
    const { code, stderr } = runCli(["tasks", "show", "does-not-exist"], {
      env: { DATABASE_PATH: tmpDb },
      cwd: process.cwd(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("not found");
  });

  it("`oauth <not-x>` exits 2 with not-yet-supported message", () => {
    const { code, stderr } = runCli(["oauth", "google"]);
    expect(code).toBe(2);
    expect(stderr).toContain("not yet supported");
  });

  it("`review` on an empty DB prints `no pending reviews`", () => {
    const { code, stdout } = runCli(["review"], {
      env: { DATABASE_PATH: tmpDb },
      cwd: process.cwd(),
      input: "",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("no pending reviews");
  });
});
