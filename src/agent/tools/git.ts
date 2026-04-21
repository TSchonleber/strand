/**
 * Minimal git wrappers over ctx.executor.bash.
 *
 * All commands resolve the repo from args.repo, else ctx.metadata.workdir,
 * else defaults.workdir. git_commit is `destructive` + `requiresLive`. Reads
 * are side-effect-free (from our point of view; git itself pokes at locks).
 */

import { env } from "@/config";
import type { AgentContext, Tool } from "../types";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveRepo(
  args: { repo?: string },
  ctx: AgentContext,
  defaults: { workdir?: string },
): string {
  const meta = ctx.metadata;
  const fromCtx = meta && typeof meta["workdir"] === "string" ? meta["workdir"] : undefined;
  const repo = args.repo ?? fromCtx ?? defaults.workdir;
  if (!repo) {
    throw new Error("git: no repo path (pass args.repo or set ctx.metadata.workdir)");
  }
  return repo;
}

interface BashOut {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runGit(ctx: AgentContext, repo: string, argvCmd: string): Promise<BashOut> {
  if (!ctx.executor) {
    throw new Error("git: no ComputerExecutor configured in AgentContext");
  }
  const wrapped = `cd ${shellQuote(repo)} && ${argvCmd}`;
  const res = await ctx.executor.bash(wrapped);
  if (res.exitCode !== 0) {
    throw new Error(`git failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
}

export interface GitStatusArgs {
  repo?: string;
}
export interface GitStatusResult {
  clean: boolean;
  porcelain: string;
}

export function makeGitStatus(
  defaults: { workdir?: string } = {},
): Tool<GitStatusArgs, GitStatusResult> {
  return {
    name: "git_status",
    description: "git status --porcelain=v1 -b in the target repo.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string" } },
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args, ctx) {
      const repo = resolveRepo(args, ctx, defaults);
      const out = await runGit(ctx, repo, "git status --porcelain=v1 -b");
      const lines = out.stdout.split("\n").filter((l) => l.length > 0);
      const clean = lines.every((l) => l.startsWith("##"));
      return { clean, porcelain: out.stdout };
    },
  };
}

export interface GitDiffArgs {
  repo?: string;
  staged?: boolean;
  paths?: string[];
}
export interface GitDiffResult {
  diff: string;
}

export function makeGitDiff(defaults: { workdir?: string } = {}): Tool<GitDiffArgs, GitDiffResult> {
  return {
    name: "git_diff",
    description: "git diff (or git diff --staged) against the index.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string" },
        staged: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args, ctx) {
      const repo = resolveRepo(args, ctx, defaults);
      const stagedFlag = args.staged === true ? "--staged" : "";
      const pathArgs =
        args.paths && args.paths.length > 0 ? ` -- ${args.paths.map(shellQuote).join(" ")}` : "";
      const out = await runGit(ctx, repo, `git diff --no-color ${stagedFlag}${pathArgs}`);
      return { diff: out.stdout };
    },
  };
}

export interface GitLogArgs {
  repo?: string;
  n?: number;
}
export interface GitLogCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}
export interface GitLogResult {
  commits: GitLogCommit[];
}

export function makeGitLog(defaults: { workdir?: string } = {}): Tool<GitLogArgs, GitLogResult> {
  return {
    name: "git_log",
    description: "Last N commits (default 20).",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string" },
        n: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args, ctx) {
      const repo = resolveRepo(args, ctx, defaults);
      const n = args.n ?? 20;
      const fmt = "%H%x1f%an%x1f%aI%x1f%s";
      const out = await runGit(ctx, repo, `git log -n ${n} --pretty=format:${shellQuote(fmt)}`);
      const commits: GitLogCommit[] = [];
      for (const line of out.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [hash, author, date, subject] = line.split("\x1f");
        commits.push({
          hash: hash ?? "",
          author: author ?? "",
          date: date ?? "",
          subject: subject ?? "",
        });
      }
      return { commits };
    },
  };
}

export interface GitBranchArgs {
  repo?: string;
}
export interface GitBranchResult {
  current: string;
  branches: string[];
}

export function makeGitBranch(
  defaults: { workdir?: string } = {},
): Tool<GitBranchArgs, GitBranchResult> {
  return {
    name: "git_branch",
    description: "List local branches; mark the current one.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string" } },
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args, ctx) {
      const repo = resolveRepo(args, ctx, defaults);
      const out = await runGit(ctx, repo, "git branch --no-color");
      const branches: string[] = [];
      let current = "";
      for (const line of out.stdout.split("\n")) {
        if (!line.trim()) continue;
        const isCurrent = line.startsWith("*");
        const name = line.replace(/^\*?\s+/, "").trim();
        if (!name) continue;
        branches.push(name);
        if (isCurrent) current = name;
      }
      return { current, branches };
    },
  };
}

export class GitGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitGateError";
  }
}

export interface GitCommitArgs {
  repo?: string;
  message: string;
  files?: string[];
}
export interface GitCommitResult {
  committed: boolean;
  hash: string;
}

export function makeGitCommit(
  defaults: { workdir?: string } = {},
): Tool<GitCommitArgs, GitCommitResult> {
  return {
    name: "git_commit",
    description: "Stage files (or all if omitted) and commit with the given message.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string" },
        message: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["message"],
      additionalProperties: false,
    },
    sideEffects: "destructive",
    requiresLive: true,
    gate(_args: GitCommitArgs, ctx: AgentContext) {
      const mode = env.STRAND_MODE;
      const allowShadow = ctx.metadata?.["allowShadowGit"] === true;
      if (mode !== "live" && !allowShadow) {
        throw new GitGateError(
          `git_commit: STRAND_MODE=${mode}, requires live (or ctx.metadata.allowShadowGit=true)`,
        );
      }
    },
    async execute(args, ctx) {
      const repo = resolveRepo(args, ctx, defaults);
      const addTarget =
        args.files && args.files.length > 0 ? args.files.map(shellQuote).join(" ") : "-A";
      await runGit(ctx, repo, `git add ${addTarget}`);
      await runGit(ctx, repo, `git commit -m ${shellQuote(args.message)}`);
      const hashOut = await runGit(ctx, repo, "git rev-parse HEAD");
      return { committed: true, hash: hashOut.stdout.trim() };
    },
  };
}
