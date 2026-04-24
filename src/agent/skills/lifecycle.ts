/**
 * Skill lifecycle — executable skill records, usage metrics, nightly scorer,
 * and brainctl decision integration.
 *
 * Markdown skill files remain the human-readable source of truth;
 * this module tracks runtime metrics in SQLite and manages state transitions.
 *
 * Statuses: active | retired | draft | queued_draft | queued_retire
 * No silent retirement — everything queues for operator approval.
 */

import { db as defaultDb } from "@/db";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";

// ─── Types ─────────────────────────────────────────────────────────────────

export type SkillStatus = "active" | "retired" | "draft" | "queued_draft" | "queued_retire";

export interface SkillRecord {
  name: string;
  status: SkillStatus;
  usageCount: number;
  successCount: number;
  tokenCostSamples: number[];
  lastUsedAt: string | null;
  trustScore: number;
  triggers: string[];
  supersedes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillDecision {
  id: string;
  skillName: string;
  proposalKind: "draft" | "retire";
  decision: "accepted" | "rejected";
  decidedBy: "user" | "auto";
  rationale: string | null;
  suppressedUntil: string | null;
  createdAt: string;
}

export interface UsageEvent {
  skillName: string;
  success: boolean;
  tokenCost: number;
}

export interface ScorerResult {
  queuedRetire: string[];
  queuedDraft: string[];
  skipped: string[];
}

// ─── Percentile helpers ────────────────────────────────────────────────────

const MAX_COST_SAMPLES = 100;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export function tokenCostP50(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return percentile(s, 50);
}

export function tokenCostP95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return percentile(s, 95);
}

// ─── SQLite row mapping ────────────────────────────────────────────────────

interface SkillRecordRow {
  name: string;
  status: string;
  usage_count: number;
  success_count: number;
  token_cost_samples_json: string | null;
  last_used_at: string | null;
  trust_score: number;
  triggers_json: string | null;
  supersedes_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SkillDecisionRow {
  id: string;
  skill_name: string;
  proposal_kind: string;
  decision: string;
  decided_by: string;
  rationale: string | null;
  suppressed_until: string | null;
  created_at: string;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseNumberArray(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function rowToRecord(r: SkillRecordRow): SkillRecord {
  return {
    name: r.name,
    status: r.status as SkillStatus,
    usageCount: r.usage_count,
    successCount: r.success_count,
    tokenCostSamples: parseNumberArray(r.token_cost_samples_json),
    lastUsedAt: r.last_used_at,
    trustScore: r.trust_score,
    triggers: parseJsonArray(r.triggers_json),
    supersedes: parseJsonArray(r.supersedes_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToDecision(r: SkillDecisionRow): SkillDecision {
  return {
    id: r.id,
    skillName: r.skill_name,
    proposalKind: r.proposal_kind as "draft" | "retire",
    decision: r.decision as "accepted" | "rejected",
    decidedBy: r.decided_by as "user" | "auto",
    rationale: r.rationale,
    suppressedUntil: r.suppressed_until,
    createdAt: r.created_at,
  };
}

// ─── SkillRecordStore ──────────────────────────────────────────────────────

export class SkillRecordStore {
  private readonly db: BetterSqliteDatabase;

  constructor(database?: BetterSqliteDatabase) {
    this.db = database ?? defaultDb();
  }

  upsert(
    name: string,
    fields: Partial<Pick<SkillRecord, "status" | "triggers" | "supersedes" | "trustScore">>,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO skill_records (name, status, triggers_json, supersedes_json, trust_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           status = COALESCE(?, status),
           triggers_json = COALESCE(?, triggers_json),
           supersedes_json = COALESCE(?, supersedes_json),
           trust_score = COALESCE(?, trust_score),
           updated_at = ?`,
      )
      .run(
        name,
        fields.status ?? "active",
        fields.triggers ? JSON.stringify(fields.triggers) : null,
        fields.supersedes ? JSON.stringify(fields.supersedes) : null,
        fields.trustScore ?? 1.0,
        now,
        now,
        fields.status ?? null,
        fields.triggers ? JSON.stringify(fields.triggers) : null,
        fields.supersedes ? JSON.stringify(fields.supersedes) : null,
        fields.trustScore ?? null,
        now,
      );
  }

  get(name: string): SkillRecord | null {
    const row = this.db.prepare("SELECT * FROM skill_records WHERE name = ?").get(name) as
      | SkillRecordRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByStatus(status: SkillStatus, limit = 100): SkillRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM skill_records WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
      .all(status, limit) as SkillRecordRow[];
    return rows.map(rowToRecord);
  }

  listActive(): SkillRecord[] {
    return this.listByStatus("active");
  }

  listAll(limit = 500): SkillRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM skill_records ORDER BY name LIMIT ?")
      .all(limit) as SkillRecordRow[];
    return rows.map(rowToRecord);
  }

  recordUsage(event: UsageEvent): void {
    const now = new Date().toISOString();
    const existing = this.get(event.skillName);
    if (!existing) {
      this.upsert(event.skillName, {});
    }
    const samples = existing?.tokenCostSamples ?? [];
    samples.push(event.tokenCost);
    if (samples.length > MAX_COST_SAMPLES) {
      samples.splice(0, samples.length - MAX_COST_SAMPLES);
    }

    this.db
      .prepare(
        `UPDATE skill_records SET
           usage_count = usage_count + 1,
           success_count = success_count + CASE WHEN ? THEN 1 ELSE 0 END,
           token_cost_samples_json = ?,
           last_used_at = ?,
           updated_at = ?
         WHERE name = ?`,
      )
      .run(event.success ? 1 : 0, JSON.stringify(samples), now, now, event.skillName);
  }

  updateStatus(name: string, status: SkillStatus): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE skill_records SET status = ?, updated_at = ? WHERE name = ?")
      .run(status, now, name);
  }

  removeFromIndex(name: string): void {
    this.updateStatus(name, "retired");
  }
}

// ─── Nightly scorer ────────────────────────────────────────────────────────

const HIT_RATE_THRESHOLD = 0.15;
const SUCCESS_RATE_THRESHOLD = 0.5;
const MIN_USAGE_FOR_SUCCESS_RATE = 10;
const SUPPRESSION_DAYS = 30;

export interface ScorerOpts {
  store: SkillRecordStore;
  decisionStore: SkillDecisionStore;
  totalInvocations: number;
}

export function runNightlyScorer(opts: ScorerOpts): ScorerResult {
  const { store, decisionStore, totalInvocations } = opts;
  const active = store.listActive();
  const result: ScorerResult = { queuedRetire: [], queuedDraft: [], skipped: [] };

  for (const skill of active) {
    if (decisionStore.isSuppressed(skill.name, "retire")) {
      result.skipped.push(skill.name);
      continue;
    }

    const hitRate = totalInvocations > 0 ? skill.usageCount / totalInvocations : 0;
    const successRate =
      skill.usageCount >= MIN_USAGE_FOR_SUCCESS_RATE ? skill.successCount / skill.usageCount : 1.0;

    const isSuperseded = skill.supersedes.length === 0 && isSupersededByOther(skill.name, store);

    if (
      hitRate < HIT_RATE_THRESHOLD ||
      (successRate < SUCCESS_RATE_THRESHOLD && skill.usageCount >= MIN_USAGE_FOR_SUCCESS_RATE) ||
      isSuperseded
    ) {
      store.updateStatus(skill.name, "queued_retire");
      result.queuedRetire.push(skill.name);
    }
  }

  return result;
}

function isSupersededByOther(name: string, store: SkillRecordStore): boolean {
  const all = store.listActive();
  return all.some((s) => s.name !== name && s.supersedes.includes(name));
}

// ─── SkillDecisionStore ────────────────────────────────────────────────────

export class SkillDecisionStore {
  private readonly db: BetterSqliteDatabase;

  constructor(database?: BetterSqliteDatabase) {
    this.db = database ?? defaultDb();
  }

  record(decision: Omit<SkillDecision, "createdAt">): void {
    const suppressedUntil =
      decision.decision === "rejected"
        ? new Date(Date.now() + SUPPRESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
        : null;

    this.db
      .prepare(
        `INSERT INTO skill_decisions (id, skill_name, proposal_kind, decision, decided_by, rationale, suppressed_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.skillName,
        decision.proposalKind,
        decision.decision,
        decision.decidedBy,
        decision.rationale ?? null,
        suppressedUntil,
      );
  }

  isSuppressed(skillName: string, proposalKind: string): boolean {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 FROM skill_decisions
         WHERE skill_name = ? AND proposal_kind = ? AND decision = 'rejected'
           AND suppressed_until > ?
         LIMIT 1`,
      )
      .get(skillName, proposalKind, now);
    return row !== undefined;
  }

  listForSkill(skillName: string, limit = 50): SkillDecision[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM skill_decisions WHERE skill_name = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(skillName, limit) as SkillDecisionRow[];
    return rows.map(rowToDecision);
  }
}

// ─── Brainctl adapter ──────────────────────────────────────────────────────

export interface BrainctlDecisionEvent {
  type: "skill_decision";
  skillName: string;
  proposalKind: "draft" | "retire";
  decision: "accepted" | "rejected";
  decidedBy: "user" | "auto";
  rationale: string | null;
  timestamp: string;
}

export function toBrainctlDecisionEvent(d: SkillDecision): BrainctlDecisionEvent {
  return {
    type: "skill_decision",
    skillName: d.skillName,
    proposalKind: d.proposalKind,
    decision: d.decision,
    decidedBy: d.decidedBy,
    rationale: d.rationale,
    timestamp: d.createdAt,
  };
}

/**
 * Accept a skill lifecycle proposal.
 * - retire proposals: mark skill as retired, remove from retrieval index
 * - draft proposals: mark skill as active (promote from draft)
 */
export function acceptProposal(opts: {
  store: SkillRecordStore;
  decisionStore: SkillDecisionStore;
  skillName: string;
  proposalKind: "draft" | "retire";
  decidedBy: "user" | "auto";
  rationale?: string;
}): SkillDecision {
  const { store, decisionStore, skillName, proposalKind, decidedBy, rationale } = opts;
  const id = `sd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  if (proposalKind === "retire") {
    store.removeFromIndex(skillName);
  } else {
    store.updateStatus(skillName, "active");
  }

  const decision: Omit<SkillDecision, "createdAt"> = {
    id,
    skillName,
    proposalKind,
    decision: "accepted",
    decidedBy,
    rationale: rationale ?? null,
    suppressedUntil: null,
  };
  decisionStore.record(decision);

  return { ...decision, createdAt: new Date().toISOString() };
}

/**
 * Reject a skill lifecycle proposal.
 * Suppresses the same proposal for 30 days.
 */
export function rejectProposal(opts: {
  store: SkillRecordStore;
  decisionStore: SkillDecisionStore;
  skillName: string;
  proposalKind: "draft" | "retire";
  decidedBy: "user" | "auto";
  rationale?: string;
}): SkillDecision {
  const { store, decisionStore, skillName, proposalKind, decidedBy, rationale } = opts;
  const id = `sd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // Revert to active if it was queued
  const record = store.get(skillName);
  if (record && (record.status === "queued_retire" || record.status === "queued_draft")) {
    store.updateStatus(skillName, record.status === "queued_retire" ? "active" : "draft");
  }

  const decision: Omit<SkillDecision, "createdAt"> = {
    id,
    skillName,
    proposalKind,
    decision: "rejected",
    decidedBy,
    rationale: rationale ?? null,
    suppressedUntil: null,
  };
  decisionStore.record(decision);

  return { ...decision, createdAt: new Date().toISOString() };
}
