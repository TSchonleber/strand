import type { Command } from "commander";
import type { CliContext } from "../index";
import { printJson, printLine, printTable } from "../util/output";
import { getResolvedConfig } from "../util/resolved-config";

interface RunOptions {
  maxSteps?: string;
  maxIterations?: string;
  maxDepth?: string;
  tools?: string[];
  enableDestructive?: boolean;
  store: boolean;
  budgetTokens?: string;
  budgetUsd?: string;
  budgetWallclockMs?: string;
  budgetToolCalls?: string;
  json?: boolean;
  executor?: "noop" | "docker";
}

function toInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`expected integer, got "${v}"`);
  return n;
}

function toFloat(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`expected number, got "${v}"`);
  return n;
}

function flattenTools(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.flatMap((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

export function registerRunCmd(program: Command, _ctx: CliContext): void {
  program
    .command("run")
    .description("run an agentic plan for a natural-language goal")
    .argument("<goal>", "natural-language goal")
    .option("--max-steps <n>", "max PlanSteps")
    .option("--max-iterations <n>", "max agentic-loop iterations per step")
    .option("--max-depth <n>", "max spawn() depth")
    .option("--tools <names...>", "comma-separated or repeated tool names to allow")
    .option("--enable-destructive", "allow destructive tools (fs_write, git_commit)")
    .option("--no-store", "don't persist TaskGraph (ephemeral run)")
    .option("--budget-tokens <n>", "token budget")
    .option("--budget-usd <dollars>", "USD budget (converted to ticks × 1e10)")
    .option("--budget-wallclock-ms <ms>", "wall-clock budget in ms")
    .option("--budget-tool-calls <n>", "max total tool invocations")
    .option("--json", "emit final PlanRunResult as JSON to stdout")
    .option("--executor <noop|docker>", "computer-use executor", "noop")
    .action(async (goal: string, opts: RunOptions, cmd: Command) => {
      const resolved = getResolvedConfig(cmd);
      const cfg = resolved.config;

      // Lazy-imports: keep `strand --help` and `strand config validate` fast
      // and free of env/zod validation from downstream domain modules.
      const [{ llm }, agent] = await Promise.all([import("@/clients/llm"), import("@/agent")]);
      const {
        DefaultToolRegistry,
        NoopExecutor,
        SqliteTaskGraphStore,
        createBudget,
        runPlan,
        tools: toolsNs,
      } = agent;

      const provider = await llm();

      const registry = new DefaultToolRegistry();
      const workdirOpt: { workdir?: string } = {};
      if (cfg.tools.workdir !== undefined) workdirOpt.workdir = cfg.tools.workdir;
      toolsNs.registerDefaults(registry, {
        enableDestructive: opts.enableDestructive ?? cfg.tools.enableDestructive,
        ...workdirOpt,
      });

      const allowedNames = flattenTools(opts.tools);
      const toolRegistry = allowedNames ? registry.allowlist(allowedNames) : registry;

      const budgetLimits: Parameters<typeof createBudget>[0] = {};
      const defs = cfg.budget.defaults;
      const tokens = toInt(opts.budgetTokens) ?? defs.tokens;
      if (tokens !== undefined) budgetLimits.tokens = tokens;
      const usdDollars = toFloat(opts.budgetUsd);
      const usdTicks = usdDollars !== undefined ? Math.round(usdDollars * 1e10) : defs.usdTicks;
      if (usdTicks !== undefined) budgetLimits.usdTicks = usdTicks;
      const wc = toInt(opts.budgetWallclockMs) ?? defs.wallClockMs;
      if (wc !== undefined) budgetLimits.wallClockMs = wc;
      const tc = toInt(opts.budgetToolCalls) ?? defs.toolCalls;
      if (tc !== undefined) budgetLimits.toolCalls = tc;
      const budget = createBudget(budgetLimits);

      const executor = opts.executor === "docker" ? undefined : new NoopExecutor();

      const ctx = {
        provider,
        tools: toolRegistry,
        budget,
        depth: 0,
        ...(executor ? { executor } : {}),
      };

      const store = opts.store ? new SqliteTaskGraphStore() : undefined;

      const maxSteps = toInt(opts.maxSteps) ?? cfg.agent.maxSteps;
      const maxIterations = toInt(opts.maxIterations) ?? cfg.agent.maxIterationsPerStep;
      const maxDepth = toInt(opts.maxDepth) ?? cfg.agent.maxDepth;

      const result = await runPlan({
        ctx,
        goal,
        maxSteps,
        maxIterationsPerStep: maxIterations,
        maxDepth,
        ...(store ? { store } : {}),
      });

      if (opts.json) {
        printJson(result);
      } else {
        printLine(`graph ${result.graphId}`);
        printLine(`status ${result.status}  stopReason ${result.stopReason}`);
        printLine(
          `duration ${result.durationMs}ms  toolCalls ${result.totalToolCalls}  cost ${result.totalUsage.costInUsdTicks} ticks`,
        );
        printLine("");
        printTable(result.steps, [
          { header: "status", value: (s) => s.status, maxWidth: 10 },
          { header: "goal", value: (s) => s.goal, maxWidth: 70 },
          { header: "ms", value: (s) => elapsedMs(s), maxWidth: 8 },
        ]);
      }

      process.exit(result.status === "completed" ? 0 : 1);
    });
}

function elapsedMs(s: { startedAt?: string; completedAt?: string }): string {
  if (!s.startedAt || !s.completedAt) return "";
  return String(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime());
}
