import type { Budget, BudgetLimits } from "@/agent/types";
import type { CockpitEvent, SubagentBackend } from "./events";

export const MAX_SUBAGENT_DEPTH = 3;
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 3;
export const DEFAULT_SUBAGENT_HEARTBEAT_MS = 30_000;
export const DEFAULT_SUBAGENT_STALE_MS = 10 * 60_000;

export type SpawnMode = "oneshot" | "interactive";

export interface SpawnSpec {
  task: string;
  backend: SubagentBackend;
  parentSessionId: string;
  mode?: SpawnMode;
  cmd?: string;
  args?: readonly string[];
  parser?: string;
  allowedTools?: readonly string[];
  budget?: Partial<BudgetLimits>;
  depth?: number;
  metadata?: Record<string, unknown>;
}

export interface SubagentStatus {
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  endedAt?: string;
  exit?: number;
  message?: string;
}

export interface SubagentHandle {
  send(input: string): Promise<void>;
  readonly events: AsyncIterable<CockpitEvent>;
  status(): Promise<SubagentStatus>;
  cancel(): Promise<void>;
  readonly budget: Budget;
}

export interface Subagent {
  readonly id: string;
  readonly backend: SubagentBackend;
  spawn(spec: SpawnSpec): Promise<SubagentHandle>;
}
