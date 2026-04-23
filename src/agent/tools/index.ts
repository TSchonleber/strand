/**
 * Built-in tool barrel + registerDefaults helper.
 */

import { isExecutable } from "@/util/which";
import type { ComputerExecutor } from "../executor";
import type { ToolRegistry } from "../types";
import { makeBrainEntityGet, makeBrainMemorySearch } from "./brainctl";
import { makeFsRead, makeFsSearch, makeFsWrite } from "./fs";
import { makeGitBranch, makeGitCommit, makeGitDiff, makeGitLog, makeGitStatus } from "./git";
import { makeHttpFetch } from "./http";
import { makeShellBash } from "./shell";

export * from "./brainctl";
export * from "./fs";
export * from "./git";
export * from "./http";
export * from "./shell";

export interface RegisterDefaultsOptions {
  /** If true, register git_commit and fs_write. Default false. */
  enableDestructive?: boolean;
  /** Default workdir baked into fs/git tool closures. */
  workdir?: string;
  /**
   * ComputerExecutor reference. Not consumed here (tools read from
   * ctx.executor at execute() time); present so callers have one place to
   * pass the full tool-plumbing config.
   */
  executor?: ComputerExecutor;
  /**
   * Register brainctl wrapper tools. Default: auto — register only when the
   * `brainctl` binary is resolvable on PATH. Set `"always"` to force
   * registration (useful if the binary appears later, or for tests), or
   * `"never"` to suppress.
   */
  brainctl?: "auto" | "always" | "never";
}

export function registerDefaults(registry: ToolRegistry, opts: RegisterDefaultsOptions = {}): void {
  const workdirOpt: { workdir?: string } = {};
  if (opts.workdir !== undefined) workdirOpt.workdir = opts.workdir;

  // fs
  registry.register(makeFsRead(workdirOpt));
  registry.register(makeFsSearch(workdirOpt));

  // shell
  registry.register(makeShellBash());

  // http
  registry.register(makeHttpFetch());

  // git (read-only)
  registry.register(makeGitStatus(workdirOpt));
  registry.register(makeGitDiff(workdirOpt));
  registry.register(makeGitLog(workdirOpt));
  registry.register(makeGitBranch(workdirOpt));

  // brainctl wrappers — skipped when the `brainctl` binary is not on PATH
  // (registering them anyway is correct but produces noisy ENOENT errors the
  // first time the LLM tries them on a fresh install).
  const brainctlMode = opts.brainctl ?? "auto";
  const brainctlCmd = process.env["BRAINCTL_COMMAND"] ?? "brainctl";
  const brainctlOn =
    brainctlMode === "always" || (brainctlMode === "auto" && isExecutable(brainctlCmd));
  if (brainctlOn) {
    registry.register(makeBrainMemorySearch());
    registry.register(makeBrainEntityGet());
  }

  if (opts.enableDestructive === true) {
    registry.register(makeFsWrite(workdirOpt));
    registry.register(makeGitCommit(workdirOpt));
  }
}
