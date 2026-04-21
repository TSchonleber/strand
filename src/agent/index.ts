// Agent harness barrel.

// Computer-use executors:
export { DockerExecutor, NoopExecutor } from "./executor";
export type {
  BashResult,
  ComputerExecutor,
  DockerExecFn,
  DockerExecResult,
  DockerExecutorConfig,
  MouseButton,
  Screenshot,
  ScrollDirection,
  TextEditorCommand,
} from "./executor";

// Agentic loop:
export { runAgenticLoop } from "./loop";
export type {
  LocalTool,
  LoopContext,
  LoopInput,
  LoopOutput,
  LoopStopReason,
  LoopTraceEntry,
} from "./loop";

// Plan runner + multi-agent spawn:
export { runPlan } from "./plan-runner";
export type { RunPlanOpts } from "./plan-runner";
export { spawn } from "./spawn";
export type { SpawnArgs } from "./spawn";

// Budget:
export { createBudget, DefaultBudget, mergeLimits, remaining } from "./budget";

// Tool registry:
export { DefaultToolRegistry } from "./registry";

// TaskGraph persistence:
export { SqliteTaskGraphStore, createTaskGraph, resumeTaskGraph } from "./task-graph";

// Tool <-> loop bridging:
export { localToolsForAgent, toolToLocal } from "./context";

// Core types:
export type {
  AgentContext,
  Budget,
  BudgetLimits,
  BudgetSnapshot,
  PlanRunResult,
  PlanStep,
  StepStatus,
  TaskGraph,
  TaskGraphStore,
  Tool,
  ToolInvocation,
  ToolRegistry,
} from "./types";
export { BudgetExceededError } from "./types";

// Built-in tools:
export * as tools from "./tools";
