import { log } from "@/util/log";
import type { AgentContext, Tool, ToolRegistry } from "../types";
import type { Skill } from "./types";

/**
 * Synthesize a Tool from a Skill.
 *
 * - Load-time: validates the skill's `allowedTools` against the registry.
 *   Unknown tools are dropped with a warning. The filtered list is captured
 *   on the Tool closure.
 * - Execute-time: interpolates args into `skill.body`, builds a child
 *   AgentContext with `depth+1`, narrows `ctx.tools` via allowlist(), and
 *   invokes `runPlan()` via a dynamic import to avoid a circular dep on the
 *   plan-runner.
 *
 * Critical: we do NOT capture the load-time registry for execute-time tool
 * scoping. The child's registry is always derived from the *calling* ctx,
 * so a parent that narrows its own allowlist correctly constrains any
 * skill its child invokes.
 */
export function skillToTool(
  skill: Skill,
  registry: ToolRegistry,
  onWarn: (msg: string, detail: Record<string, unknown>) => void = (msg, detail) =>
    log.warn(detail, msg),
): Tool<Record<string, unknown>, string> {
  const known = new Set(registry.list().map((t) => t.name));
  let filteredAllowlist: readonly string[] | undefined;
  if (skill.allowedTools !== undefined) {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const name of skill.allowedTools) {
      if (known.has(name)) {
        kept.push(name);
      } else {
        dropped.push(name);
      }
    }
    if (dropped.length > 0) {
      onWarn("skills.allowed_tools_filtered", {
        svc: "agent",
        skill: skill.name,
        dropped,
      });
    }
    filteredAllowlist = kept;
  }

  const tool: Tool<Record<string, unknown>, string> = {
    name: skill.name,
    description: skill.description,
    parameters: skill.parameters,
    sideEffects: skill.sideEffects ?? "local",
    requiresLive: skill.requiresLive ?? false,
    async execute(args, ctx) {
      const goal = buildGoal(skill, args);

      // Narrow tools from the *caller's* registry — honours parent scope.
      const scopedTools =
        filteredAllowlist !== undefined ? ctx.tools.allowlist(filteredAllowlist) : ctx.tools;

      const childCtx: AgentContext = {
        provider: ctx.provider,
        tools: scopedTools,
        budget: ctx.budget.fork(),
        parent: ctx,
        depth: ctx.depth + 1,
        metadata: { ...(ctx.metadata ?? {}), skill: skill.name },
        ...(ctx.executor !== undefined ? { executor: ctx.executor } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      };

      log.info(
        {
          svc: "agent",
          op: "skill.invoke",
          skill: skill.name,
          depth: childCtx.depth,
          toolCount: childCtx.tools.list().length,
        },
        "agent.skill.invoke",
      );

      // Dynamic import breaks the potential cycle:
      //   plan-runner → (loads tools) → skill-as-tool → runPlan
      const { runPlan } = await import("../plan-runner");
      const result = await runPlan({ ctx: childCtx, goal });

      if (result.status !== "completed") {
        const failedStepErrors = result.steps
          .filter((s) => s.error)
          .map((s) => `[${s.id}] ${s.error}`)
          .join("; ");
        const detail = failedStepErrors.length > 0 ? ` — ${failedStepErrors}` : "";
        throw new Error(
          `skill '${skill.name}' did not complete (stopReason=${result.stopReason})${detail}`,
        );
      }
      return result.finalOutput;
    },
  };
  return tool;
}

/**
 * Substitute `{{paramName}}` placeholders in the skill body with the
 * corresponding stringified argument value. Missing params render as the
 * sentinel `{{paramName: MISSING}}` so the model sees the gap rather than
 * silently swallowing it.
 */
export function buildGoal(skill: Skill, args: Record<string, unknown>): string {
  return skill.body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    if (Object.hasOwn(args, key)) {
      const v = args[key];
      if (v === undefined || v === null) return `{{${key}: MISSING}}`;
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    return `{{${key}: MISSING}}`;
  });
}
