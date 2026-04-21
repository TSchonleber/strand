import type Database from "better-sqlite3";
import { policies } from "@/config";
import type { Candidate } from "@/types/actions";

export interface DiversityResult {
  ok: boolean;
  reasons: string[];
  ruleIds: string[];
}

export function diversityRule(db: Database.Database, c: Candidate<"proposed">): DiversityResult {
  const reasons: string[] = [];
  const ruleIds: string[] = [];

  const dayStart = new Date(new Date().toISOString().slice(0, 10)).toISOString();
  const total = (db
    .prepare(
      "SELECT COUNT(*) AS n FROM action_log WHERE status IN ('executed', 'approved') AND created_at >= ?",
    )
    .get(dayStart) as { n: number }).n;

  if (total === 0) return { ok: true, reasons, ruleIds };

  const sameKind = (db
    .prepare(
      "SELECT COUNT(*) AS n FROM action_log WHERE status IN ('executed', 'approved') AND kind = ? AND created_at >= ?",
    )
    .get(c.action.kind, dayStart) as { n: number }).n;

  const share = (sameKind + 1) / (total + 1);
  if (share > policies.diversity.max_share_per_kind) {
    reasons.push(
      `kind_share_exceeded:${c.action.kind}:${share.toFixed(2)}>${policies.diversity.max_share_per_kind}`,
    );
    ruleIds.push("diversity.kind");
  }

  return { ok: reasons.length === 0, reasons, ruleIds };
}
