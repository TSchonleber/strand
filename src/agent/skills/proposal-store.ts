/**
 * SQLite-backed skill proposal store. Matches the TaskGraphStore pattern:
 * transactional saves, simple indexed queries, no abstractions beyond what
 * the CLI + auto-create flow actually use.
 */

import { db as defaultDb } from "@/db";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { SkillProposal, SkillProposalStore } from "./auto-create";

interface Row {
  id: string;
  graph_id: string | null;
  proposed_name: string;
  proposed_description: string;
  proposed_doc_json: string;
  status: SkillProposal["status"];
  reasoning: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: "auto" | "human" | null;
}

function rowToProposal(r: Row): SkillProposal {
  const p: SkillProposal = {
    id: r.id,
    graphId: r.graph_id,
    proposedName: r.proposed_name,
    proposedDescription: r.proposed_description,
    proposedDoc: JSON.parse(r.proposed_doc_json),
    status: r.status,
    reasoning: r.reasoning ?? "",
    createdAt: r.created_at,
  };
  if (r.decided_at) p.decidedAt = r.decided_at;
  if (r.decided_by) p.decidedBy = r.decided_by;
  return p;
}

export class SqliteSkillProposalStore implements SkillProposalStore {
  private readonly db: BetterSqliteDatabase;

  constructor(database?: BetterSqliteDatabase) {
    this.db = database ?? defaultDb();
  }

  async save(p: SkillProposal): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_skill_proposals
         (id, graph_id, proposed_name, proposed_description, proposed_doc_json,
          status, reasoning, created_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.graphId,
        p.proposedName,
        p.proposedDescription,
        JSON.stringify(p.proposedDoc),
        p.status,
        p.reasoning,
        p.createdAt,
        p.decidedAt ?? null,
        p.decidedBy ?? null,
      );
  }

  async load(id: string): Promise<SkillProposal | null> {
    const row = this.db.prepare("SELECT * FROM agent_skill_proposals WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? rowToProposal(row) : null;
  }

  async listByStatus(status: SkillProposal["status"], limit = 100): Promise<SkillProposal[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_skill_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(status, limit) as Row[];
    return rows.map(rowToProposal);
  }

  async updateStatus(
    id: string,
    status: SkillProposal["status"],
    decidedBy: "auto" | "human",
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE agent_skill_proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?",
      )
      .run(status, now, decidedBy, id);
  }
}

export function makeSqliteSkillProposalStore(database?: BetterSqliteDatabase): SkillProposalStore {
  return new SqliteSkillProposalStore(database);
}
