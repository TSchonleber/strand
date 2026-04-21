/**
 * shell_bash — sandboxed bash via ctx.executor.
 *
 * gate() reads env.STRAND_MODE at call time; in production the tool must run
 * with STRAND_MODE=live. In shadow/gated modes the gate throws a typed error
 * unless ctx.metadata.allowShadowBash === true (used by tests / scripts).
 */

import { env } from "@/config";
import type { BashResult } from "../executor";
import type { AgentContext, Tool } from "../types";

const BASH_MAX_COMMAND_BYTES = 16 * 1024;

export class ShellGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellGateError";
  }
}

export interface ShellBashArgs {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface ShellBashResult extends BashResult {
  truncated: boolean;
}

export function makeShellBash(): Tool<ShellBashArgs, ShellBashResult> {
  return {
    name: "shell_bash",
    description: "Run a bash command inside the configured sandbox executor.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1 },
        cwd: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    sideEffects: "external",
    requiresLive: true,
    gate(args: ShellBashArgs, ctx: AgentContext) {
      if (Buffer.byteLength(args.command, "utf8") > BASH_MAX_COMMAND_BYTES) {
        throw new ShellGateError(`shell_bash: command exceeds ${BASH_MAX_COMMAND_BYTES} byte cap`);
      }
      const mode = env.STRAND_MODE;
      const allowShadow = ctx.metadata?.["allowShadowBash"] === true;
      if (mode !== "live" && !allowShadow) {
        throw new ShellGateError(
          `shell_bash: STRAND_MODE=${mode}, requires live (or ctx.metadata.allowShadowBash=true)`,
        );
      }
    },
    async execute(args, ctx) {
      if (!ctx.executor) {
        throw new Error("shell_bash: no ComputerExecutor configured in AgentContext");
      }
      const opts: { timeoutMs?: number; cwd?: string } = {};
      if (args.timeoutMs !== undefined) opts.timeoutMs = args.timeoutMs;
      if (args.cwd !== undefined) opts.cwd = args.cwd;
      const res = await ctx.executor.bash(args.command, opts);
      return {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        truncated: res.truncated === true,
      };
    },
  };
}
