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
export { SSHExecutor, shellQuote as sshShellQuote } from "./executor-ssh";
export type {
  SSHClientLike,
  SSHConnectConfig,
  SSHExecutorConfig,
  SSHStreamLike,
} from "./executor-ssh";

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

// Context compaction:
export {
  estimateTokens,
  NoOpContextEngine,
  SummarizingContextEngine,
} from "./context-engine";
export type {
  CompressResult,
  ContextEngine,
  SummarizingContextEngineOpts,
} from "./context-engine";

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

// Skills (procedural memory as files, loaded as Tools):
export {
  SkillWriter,
  SqliteSkillProposalStore,
  autoCreateSkill,
  buildGoal,
  loadSkills,
  makeSqliteSkillProposalStore,
  parseSkill,
  renderSkillFile,
  setDefaultSkillProposalStore,
  skillToTool,
} from "./skills";
export type {
  AutoCreateMode,
  AutoCreateResult,
  AutoCreateSkillOpts,
  LoadSkillsOpts,
  LoadSkillsResult,
  Skill,
  SkillDocument,
  SkillOrigin,
  SkillProposal,
  SkillProposalStore,
  SkillSideEffects,
} from "./skills";
