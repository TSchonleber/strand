import { scanForInjection } from "@/util/injection-scanner";
import { log } from "@/util/log";
import type { LocalTool, LoopContext } from "./loop";
import type { AgentContext, Tool, ToolInvocation } from "./types";

/**
 * Serialize whatever a tool returned into a string the LLM can consume.
 * Mirrors runAgenticLoop's own stringifyResult so the scanner sees the same
 * bytes the model would have seen.
 */
function stringifyToolResult(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Bridges the `Tool` (agent-harness) interface to `LocalTool` (loop-runner
 * interface) so an agent's registered tools show up as callable functions
 * inside the provider's chat loop.
 *
 * Every invocation:
 *  1. Consumes 1 from `ctx.budget.toolCalls` (throws BudgetExceededError at cap).
 *  2. Runs the tool's optional `gate`.
 *  3. Calls `tool.execute(args, ctx)`.
 *  4. Records a ToolInvocation to `ctx.metadata.invocations` if present.
 */
export function toolToLocal(tool: Tool, ctx: AgentContext): LocalTool {
  const local: LocalTool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args: unknown, _loopCtx: LoopContext) {
      ctx.budget.consumeToolCall();
      const t0 = Date.now();
      let result: unknown;
      let errorMsg: string | undefined;
      try {
        if (tool.gate) await tool.gate(args, ctx);
        result = await tool.execute(args, ctx);
        // Run the (stringified) tool result through the injection scanner
        // before handing it back to the agentic loop. runAgenticLoop will
        // call stringifyResult again on whatever we return — returning a
        // string short-circuits that to the (already sanitized) body.
        const asString = stringifyToolResult(result);
        const scanned = scanForInjection(asString);
        if (!scanned.safe) {
          log.warn(
            {
              svc: "agent",
              op: "tool_result_injection",
              tool: tool.name,
              findings: scanned.findings,
            },
            "agent.tool.unsafe_result",
          );
          return `[warning: potential prompt-injection in tool output — findings=${scanned.findings
            .map((f) => f.rule)
            .join(",")}]\n\n${scanned.sanitized}`;
        }
        // If only invisibles were stripped, still prefer the sanitized body —
        // we don't want bidi overrides leaking into the model's context.
        return scanned.sanitized;
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        const inv: ToolInvocation = {
          name: tool.name,
          args,
          at: t0,
          durationMs: Date.now() - t0,
        };
        if (errorMsg !== undefined) inv.error = errorMsg;
        else if (result !== undefined) inv.result = result;
        pushInvocation(ctx, inv);
      }
    },
  };
  if (tool.gate) {
    local.gate = (args: unknown) => Promise.resolve(tool.gate?.(args, ctx));
  }
  return local;
}

function pushInvocation(ctx: AgentContext, inv: ToolInvocation): void {
  const meta = ctx.metadata ?? {};
  const invList = Array.isArray(meta["invocations"])
    ? (meta["invocations"] as ToolInvocation[])
    : [];
  invList.push(inv);
  if (!ctx.metadata) ctx.metadata = meta;
  ctx.metadata["invocations"] = invList;
  log.debug(
    {
      svc: "agent",
      op: "tool_invocation",
      tool: inv.name,
      durationMs: inv.durationMs,
      error: inv.error,
    },
    "agent.tool.invoked",
  );
}

/**
 * Convert all tools in the agent's registry to LocalTool[] — exactly the
 * shape `runAgenticLoop` wants. Filters side-effecting tools out when the
 * agent is in shadow mode (can still be overridden via opts.includeDestructive).
 */
export function localToolsForAgent(
  ctx: AgentContext,
  opts?: { includeDestructive?: boolean },
): LocalTool[] {
  const out: LocalTool[] = [];
  for (const t of ctx.tools.list()) {
    if (!opts?.includeDestructive && t.sideEffects === "destructive") {
      continue;
    }
    out.push(toolToLocal(t, ctx));
  }
  return out;
}
