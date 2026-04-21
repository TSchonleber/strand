import {
  GitGateError,
  makeGitBranch,
  makeGitCommit,
  makeGitDiff,
  makeGitLog,
  makeGitStatus,
} from "@/agent/tools/git";
import { describe, expect, it } from "vitest";
import { FakeExecutor, makeCtx } from "./helpers";

describe("git_status", () => {
  it("parses porcelain output and reports clean state", async () => {
    const exec = new FakeExecutor([
      {
        match: (c) => c.includes("git status --porcelain=v1 -b"),
        result: { stdout: "## main\n", exitCode: 0 },
      },
    ]);
    const tool = makeGitStatus();
    const out = await tool.execute({ repo: "/tmp/repo" }, makeCtx({ executor: exec }));
    expect(out.clean).toBe(true);
    expect(exec.calls[0]?.command).toMatch(/cd '\/tmp\/repo' && git status/);
  });

  it("throws when repo is not set anywhere", async () => {
    const tool = makeGitStatus();
    await expect(tool.execute({}, makeCtx({ executor: new FakeExecutor() }))).rejects.toThrow(
      /no repo path/,
    );
  });
});

describe("git_log", () => {
  it("parses log output with N=5", async () => {
    const exec = new FakeExecutor([
      {
        match: (c) => c.includes("git log -n 5"),
        result: {
          stdout: "abc123\x1fAlice\x1f2024-01-01T00:00:00Z\x1ffirst\n",
          exitCode: 0,
        },
      },
    ]);
    const tool = makeGitLog();
    const out = await tool.execute({ repo: "/tmp/r", n: 5 }, makeCtx({ executor: exec }));
    expect(out.commits).toHaveLength(1);
    expect(out.commits[0]?.hash).toBe("abc123");
    expect(out.commits[0]?.author).toBe("Alice");
    expect(out.commits[0]?.subject).toBe("first");
  });
});

describe("git_diff + git_branch", () => {
  it("git_diff respects staged flag", async () => {
    const exec = new FakeExecutor([
      {
        match: (c) => c.includes("git diff --no-color --staged"),
        result: { stdout: "diff...", exitCode: 0 },
      },
    ]);
    const tool = makeGitDiff();
    const out = await tool.execute({ repo: "/tmp/r", staged: true }, makeCtx({ executor: exec }));
    expect(out.diff).toBe("diff...");
  });

  it("git_branch parses current + list", async () => {
    const exec = new FakeExecutor([
      {
        match: (c) => c.includes("git branch"),
        result: { stdout: "  main\n* feature/x\n  old\n", exitCode: 0 },
      },
    ]);
    const tool = makeGitBranch();
    const out = await tool.execute({ repo: "/tmp/r" }, makeCtx({ executor: exec }));
    expect(out.current).toBe("feature/x");
    expect(out.branches).toEqual(["main", "feature/x", "old"]);
  });
});

describe("git_commit", () => {
  it("gate refuses in non-live mode without allowShadowGit", () => {
    const tool = makeGitCommit();
    const ctx = makeCtx({ executor: new FakeExecutor() });
    expect(() => tool.gate?.({ message: "hi" }, ctx)).toThrow(GitGateError);
  });

  it("stages given files and commits with provided message", async () => {
    const exec = new FakeExecutor([
      { match: (c) => /git add 'a.ts' 'b.ts'/.test(c), result: { exitCode: 0 } },
      { match: (c) => /git commit -m 'msg'/.test(c), result: { exitCode: 0 } },
      { match: (c) => /git rev-parse HEAD/.test(c), result: { stdout: "deadbeef\n", exitCode: 0 } },
    ]);
    const tool = makeGitCommit();
    const ctx = makeCtx({
      executor: exec,
      metadata: { allowShadowGit: true, workdir: "/tmp/r" },
    });
    tool.gate?.({ message: "msg" }, ctx);
    const out = await tool.execute({ message: "msg", files: ["a.ts", "b.ts"] }, ctx);
    expect(out.committed).toBe(true);
    expect(out.hash).toBe("deadbeef");
    expect(exec.calls).toHaveLength(3);
  });

  it("stages -A when no files are given", async () => {
    const exec = new FakeExecutor([
      { match: (c) => /git add -A/.test(c), result: { exitCode: 0 } },
      { match: (c) => /git commit/.test(c), result: { exitCode: 0 } },
      { match: (c) => /rev-parse/.test(c), result: { stdout: "cafe\n", exitCode: 0 } },
    ]);
    const tool = makeGitCommit();
    const ctx = makeCtx({
      executor: exec,
      metadata: { allowShadowGit: true, workdir: "/tmp/r" },
    });
    const out = await tool.execute({ message: "all" }, ctx);
    expect(out.hash).toBe("cafe");
  });
});
