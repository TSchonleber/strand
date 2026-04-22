/**
 * Autonomous skill creation.
 *
 * After a successful runPlan, propose a reusable skill via LLM judgment,
 * run safety gates, and either install it directly (if the operator opted in
 * AND the skill is non-destructive) or push it to the pending-review queue
 * for human approval.
 *
 * Design bias:
 *   - Default `mode: "manual"` — human always reviews before the skill is
 *     written to disk. Auto-install is strict opt-in, and even then only for
 *     skills with sideEffects ∈ {none, local}.
 *   - Never proposes from a plan with failed steps.
 *   - Never installs a skill whose name shadows a built-in tool.
 *   - LLM proposal call has a stable promptCacheKey — this runs once per
 *     successful plan so the static prefix caches across runs.
 */

import type { LlmCall, LlmProvider } from "@/clients/llm";
import { log } from "@/util/log";
import { SKILL_PROPOSE_CACHE_KEY, SKILL_PROPOSE_SYSTEM } from "../prompts";
import type { AgentContext, PlanRunResult, PlanStep, ToolRegistry } from "../types";
import type { SkillDocument, SkillOrigin } from "./types";
import { SkillWriter } from "./writer";

// ─── Public API ──────────────────────────────────────────────────────────

export type AutoCreateMode = "off" | "manual" | "auto";

export interface AutoCreateSkillOpts {
  /** off = never propose; manual = propose + queue for review; auto = propose + install non-destructive skills directly. Default manual. */
  mode?: AutoCreateMode;
  /** Minimum completed step count to consider a plan. Default 2. */
  minSteps?: number;
  /** Minimum total tool calls across the plan. Default 1. */
  minToolCalls?: number;
  /** Where `auto` mode writes installed skills. Default `./.strand/skills`. */
  projectSkillsDir?: string;
  /** Pending-proposal store. Default SQLite store in strand.db. */
  store?: SkillProposalStore;
  /** Override the tool registry used for shadow checks. Default: ctx.tools. */
  registry?: ToolRegistry;
}

export interface SkillProposal {
  id: string;
  graphId: string | null;
  proposedName: string;
  proposedDescription: string;
  proposedDoc: SkillDocument;
  status: "pending" | "approved" | "rejected" | "installed";
  reasoning: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: "auto" | "human" | null;
}

export interface SkillProposalStore {
  save(p: SkillProposal): Promise<void>;
  load(id: string): Promise<SkillProposal | null>;
  listByStatus(status: SkillProposal["status"], limit?: number): Promise<SkillProposal[]>;
  updateStatus(
    id: string,
    status: SkillProposal["status"],
    decidedBy: "auto" | "human",
  ): Promise<void>;
}

export interface AutoCreateResult {
  attempted: boolean;
  /** The proposal id if one was created, whether queued or installed. */
  proposalId?: string;
  /** true if the skill was written to disk this pass (auto mode). */
  installed?: boolean;
  /** LLM's reasoning even when declined. */
  reasoning?: string;
  /** The reason we didn't attempt (when attempted=false). */
  skippedReason?: string;
}

// ─── Orchestration ───────────────────────────────────────────────────────

export async function autoCreateSkill(args: {
  ctx: AgentContext;
  plan: PlanRunResult;
  opts?: AutoCreateSkillOpts;
}): Promise<AutoCreateResult> {
  const { ctx, plan } = args;
  const opts: Required<Omit<AutoCreateSkillOpts, "store" | "registry">> & {
    store?: SkillProposalStore;
    registry?: ToolRegistry;
  } = {
    mode: args.opts?.mode ?? "manual",
    minSteps: args.opts?.minSteps ?? 2,
    minToolCalls: args.opts?.minToolCalls ?? 1,
    projectSkillsDir: args.opts?.projectSkillsDir ?? "./.strand/skills",
    ...(args.opts?.store !== undefined ? { store: args.opts.store } : {}),
    ...(args.opts?.registry !== undefined ? { registry: args.opts.registry } : {}),
  };

  if (opts.mode === "off") {
    return { attempted: false, skippedReason: "mode=off" };
  }

  // ─── Pre-LLM safety gates ────────────────────────────────────────────
  if (plan.status !== "completed") {
    return { attempted: false, skippedReason: `plan status=${plan.status}` };
  }
  const completedSteps = plan.steps.filter((s) => s.status === "completed");
  if (completedSteps.length < opts.minSteps) {
    return { attempted: false, skippedReason: `completedSteps<${opts.minSteps}` };
  }
  if (plan.totalToolCalls < opts.minToolCalls) {
    return { attempted: false, skippedReason: `totalToolCalls<${opts.minToolCalls}` };
  }

  // ─── LLM proposal ────────────────────────────────────────────────────
  let proposal: LlmProposalPayload;
  try {
    proposal = await proposeSkill({ provider: ctx.provider, plan });
  } catch (err) {
    log.warn(
      { svc: "agent", op: "skill.propose", err: err instanceof Error ? err.message : String(err) },
      "skill.propose_failed",
    );
    return { attempted: false, skippedReason: "proposal_call_failed" };
  }

  if (!proposal.worthCreating || !proposal.skill) {
    log.info({ svc: "agent", reasoning: proposal.reasoning }, "skill.propose.declined");
    return { attempted: true, reasoning: proposal.reasoning };
  }

  // ─── Post-LLM safety gates ───────────────────────────────────────────
  const registry = opts.registry ?? ctx.tools;
  const doc = proposal.skill;

  if (!/^[a-z][a-z0-9_-]{2,39}$/.test(doc.name)) {
    log.warn({ proposed: doc.name }, "skill.propose.invalid_name");
    return { attempted: true, reasoning: `invalid name: ${doc.name}` };
  }
  if (registry.get(doc.name)) {
    log.warn({ proposed: doc.name }, "skill.propose.shadows_existing_tool");
    return { attempted: true, reasoning: `would shadow tool: ${doc.name}` };
  }

  // Enforce sideEffects invariant: if any step in the plan mutated something
  // external, the skill must declare at least that side-effect level. The LLM
  // proposes but we take the MAX.
  const observedSideEffects = observedMaxSideEffects(plan, registry);
  if (
    observedSideEffects &&
    sideEffectRank(observedSideEffects) > sideEffectRank(doc.sideEffects ?? "none")
  ) {
    doc.sideEffects = observedSideEffects;
  }
  if (doc.sideEffects === "destructive") {
    doc.requiresLive = true;
  }

  const store = opts.store ?? getDefaultStore();
  const now = new Date().toISOString();
  const id = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // ─── Install decision ────────────────────────────────────────────────
  const canAutoInstall =
    opts.mode === "auto" &&
    (doc.sideEffects === "none" || doc.sideEffects === "local") &&
    doc.requiresLive !== true;

  if (canAutoInstall) {
    try {
      const writer = new SkillWriter(opts.projectSkillsDir);
      await writer.write(doc);
      const record: SkillProposal = {
        id,
        graphId: plan.graphId,
        proposedName: doc.name,
        proposedDescription: doc.description,
        proposedDoc: doc,
        status: "installed",
        reasoning: proposal.reasoning,
        createdAt: now,
        decidedAt: now,
        decidedBy: "auto",
      };
      await store.save(record);
      log.info(
        { svc: "agent", proposalId: id, name: doc.name, origin: "auto" as SkillOrigin },
        "skill.installed",
      );
      return { attempted: true, proposalId: id, installed: true, reasoning: proposal.reasoning };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), name: doc.name },
        "skill.install_failed_queueing",
      );
      // fall through to pending path
    }
  }

  // Queue for manual review.
  const record: SkillProposal = {
    id,
    graphId: plan.graphId,
    proposedName: doc.name,
    proposedDescription: doc.description,
    proposedDoc: doc,
    status: "pending",
    reasoning: proposal.reasoning,
    createdAt: now,
  };
  await store.save(record);
  log.info(
    { svc: "agent", proposalId: id, name: doc.name, sideEffects: doc.sideEffects },
    "skill.proposal.queued",
  );
  return { attempted: true, proposalId: id, installed: false, reasoning: proposal.reasoning };
}

// ─── LLM proposal call ────────────────────────────────────────────────────

interface LlmProposalPayload {
  worthCreating: boolean;
  reasoning: string;
  skill?: SkillDocument;
}

const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["worthCreating", "reasoning"],
  properties: {
    worthCreating: { type: "boolean" },
    reasoning: { type: "string" },
    skill: {
      type: "object",
      additionalProperties: false,
      required: ["name", "description", "parameters", "body"],
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        parameters: { type: "object" },
        allowedTools: { type: "array", items: { type: "string" } },
        sideEffects: { type: "string", enum: ["none", "local", "external", "destructive"] },
        requiresLive: { type: "boolean" },
        body: { type: "string" },
      },
    },
  },
};

async function proposeSkill(args: {
  provider: LlmProvider;
  plan: PlanRunResult;
}): Promise<LlmProposalPayload> {
  const { provider, plan } = args;
  const summary = summarizePlanForProposal(plan);

  const call: LlmCall = {
    model: proposalModel(),
    messages: [
      { role: "system", content: SKILL_PROPOSE_SYSTEM },
      { role: "user", content: summary },
    ],
    promptCacheKey: SKILL_PROPOSE_CACHE_KEY,
    structuredOutput: { name: "SkillProposal", schema: PROPOSAL_SCHEMA, strict: true },
    maxOutputTokens: 1200,
  };

  const result = await provider.chat<LlmProposalPayload>(call);
  const parsed = result.parsed ?? safeJson<LlmProposalPayload>(result.outputText);
  if (!parsed) {
    throw new Error("skill proposal returned unparseable JSON");
  }
  return parsed;
}

function proposalModel(): string {
  const cheap = process.env["LLM_MODEL_COMPOSER"];
  if (cheap && cheap.length > 0) return cheap;
  const reasoner = process.env["LLM_MODEL_REASONER"];
  if (reasoner && reasoner.length > 0) return reasoner;
  return "grok-4-1-fast-non-reasoning";
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// ─── Plan summarization for the proposal prompt ──────────────────────────

function summarizePlanForProposal(plan: PlanRunResult): string {
  const lines: string[] = [];
  lines.push(`Root goal: ${plan.rootGoal}`);
  lines.push(
    `Status: ${plan.status}  steps=${plan.steps.length}  tool_calls=${plan.totalToolCalls}`,
  );
  lines.push("");
  lines.push("Steps:");
  for (const s of plan.steps) {
    lines.push(`  - [${s.status}] ${s.goal}`);
    if (s.allowedTools && s.allowedTools.length > 0) {
      lines.push(`      tools: ${[...s.allowedTools].sort().join(", ")}`);
    }
    if (typeof s.result === "string" && s.result.length > 0) {
      lines.push(`      result: ${truncate(s.result, 300)}`);
    } else if (s.result !== undefined) {
      lines.push(`      result: ${truncate(JSON.stringify(s.result), 300)}`);
    }
    if (s.reflection) {
      lines.push(`      reflection: ${truncate(s.reflection, 240)}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ─── Side-effect arithmetic ──────────────────────────────────────────────

function sideEffectRank(level: string | undefined): number {
  switch (level) {
    case "destructive":
      return 3;
    case "external":
      return 2;
    case "local":
      return 1;
    default:
      return 0; // "none" or undefined
  }
}

function observedMaxSideEffects(
  plan: PlanRunResult,
  registry: ToolRegistry,
): "none" | "local" | "external" | "destructive" {
  let maxRank = 0;
  for (const step of plan.steps) {
    for (const name of step.allowedTools) {
      const t = registry.get(name);
      if (!t) continue;
      const r = sideEffectRank(t.sideEffects);
      if (r > maxRank) maxRank = r;
    }
  }
  void (null as unknown as PlanStep); // keep PlanStep import used if we expand this later
  return rankToLevel(maxRank);
}

function rankToLevel(r: number): "none" | "local" | "external" | "destructive" {
  switch (r) {
    case 3:
      return "destructive";
    case 2:
      return "external";
    case 1:
      return "local";
    default:
      return "none";
  }
}

// ─── Default store accessor ──────────────────────────────────────────────

let _defaultStore: SkillProposalStore | null = null;

export function setDefaultSkillProposalStore(store: SkillProposalStore | null): void {
  _defaultStore = store;
}

function getDefaultStore(): SkillProposalStore {
  if (_defaultStore) return _defaultStore;
  // Lazy-init the SQLite-backed store on first call so tests that supply
  // their own store never touch the real DB.
  // Dynamic import to break the module cycle (proposal-store imports @/db
  // which pulls in the full schema; we only need it when we actually write).
  throw new Error(
    "no default SkillProposalStore set — call setDefaultSkillProposalStore(makeSqliteSkillProposalStore()) or pass opts.store",
  );
}
