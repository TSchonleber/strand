/**
 * Phase 2 agreement metric tests.
 *
 * Mirrors the logic in src/cli/commands/review.ts `agreement` subcommand
 * so we can regression-test the math without spawning a CLI subprocess.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Row {
  status: string;
  operator_label: string | null;
}

/**
 * Pure agreement computation — takes labeled rows, returns the metric.
 * Keep in sync with the inline logic in review.ts.
 */
function computeAgreement(rows: Row[]): {
  total: number;
  decisive: number;
  unclear: number;
  agree: number;
  disagree: number;
  agreementPct: number;
  confusionMatrix: {
    trueApprove: number;
    trueReject: number;
    falseApprove: number;
    falseReject: number;
  };
  gateMet: boolean;
} {
  const labeled = rows.filter((r) => r.operator_label !== null);
  const total = labeled.length;
  let agree = 0;
  let disagree = 0;
  let unclear = 0;
  let trueApprove = 0;
  let trueReject = 0;
  let falseApprove = 0;
  let falseReject = 0;

  for (const r of labeled) {
    const policyApproved = r.status === "approved" || r.status === "executed";
    if (r.operator_label === "unclear") {
      unclear++;
      continue;
    }
    const operatorGood = r.operator_label === "good";
    if (policyApproved && operatorGood) {
      agree++;
      trueApprove++;
    } else if (!policyApproved && !operatorGood) {
      agree++;
      trueReject++;
    } else if (policyApproved && !operatorGood) {
      disagree++;
      falseApprove++;
    } else {
      disagree++;
      falseReject++;
    }
  }

  const decisive = agree + disagree;
  const agreementPct = decisive > 0 ? (agree / decisive) * 100 : 0;
  const gateMet = total >= 100 && agreementPct >= 80;

  return {
    total,
    decisive,
    unclear,
    agree,
    disagree,
    agreementPct,
    confusionMatrix: { trueApprove, trueReject, falseApprove, falseReject },
    gateMet,
  };
}

describe("Phase 2 agreement metric", () => {
  it("returns 100% when all policy verdicts match operator labels", () => {
    const rows: Row[] = [
      { status: "executed", operator_label: "good" },
      { status: "executed", operator_label: "good" },
      { status: "rejected", operator_label: "bad" },
      { status: "rejected", operator_label: "bad" },
    ];
    const m = computeAgreement(rows);
    expect(m.agreementPct).toBe(100);
    expect(m.agree).toBe(4);
    expect(m.disagree).toBe(0);
  });

  it("returns 0% when all verdicts disagree", () => {
    const rows: Row[] = [
      { status: "executed", operator_label: "bad" },
      { status: "rejected", operator_label: "good" },
    ];
    const m = computeAgreement(rows);
    expect(m.agreementPct).toBe(0);
    expect(m.disagree).toBe(2);
    expect(m.confusionMatrix.falseApprove).toBe(1);
    expect(m.confusionMatrix.falseReject).toBe(1);
  });

  it("excludes unclear labels from decisive totals", () => {
    const rows: Row[] = [
      { status: "executed", operator_label: "good" },
      { status: "executed", operator_label: "unclear" },
      { status: "rejected", operator_label: "unclear" },
      { status: "rejected", operator_label: "bad" },
    ];
    const m = computeAgreement(rows);
    expect(m.unclear).toBe(2);
    expect(m.decisive).toBe(2);
    expect(m.agree).toBe(2);
    expect(m.agreementPct).toBe(100);
  });

  it("counts approved status same as executed for policy-approved", () => {
    const rows: Row[] = [
      { status: "approved", operator_label: "good" },
      { status: "executed", operator_label: "good" },
    ];
    const m = computeAgreement(rows);
    expect(m.confusionMatrix.trueApprove).toBe(2);
    expect(m.agreementPct).toBe(100);
  });

  it("gate not met when total < 100 even with 100% agreement", () => {
    const rows: Row[] = Array.from({ length: 50 }, () => ({
      status: "executed" as const,
      operator_label: "good" as const,
    }));
    const m = computeAgreement(rows);
    expect(m.agreementPct).toBe(100);
    expect(m.total).toBe(50);
    expect(m.gateMet).toBe(false);
  });

  it("gate not met when agreement < 80% even with ≥100 labels", () => {
    const rows: Row[] = [
      ...Array.from({ length: 70 }, () => ({
        status: "executed" as const,
        operator_label: "good" as const,
      })),
      ...Array.from({ length: 30 }, () => ({
        status: "executed" as const,
        operator_label: "bad" as const,
      })),
    ];
    const m = computeAgreement(rows);
    expect(m.total).toBe(100);
    expect(m.agreementPct).toBe(70);
    expect(m.gateMet).toBe(false);
  });

  it("gate met at exactly 100 labels and 80% agreement", () => {
    const rows: Row[] = [
      ...Array.from({ length: 80 }, () => ({
        status: "executed" as const,
        operator_label: "good" as const,
      })),
      ...Array.from({ length: 20 }, () => ({
        status: "executed" as const,
        operator_label: "bad" as const,
      })),
    ];
    const m = computeAgreement(rows);
    expect(m.total).toBe(100);
    expect(m.agreementPct).toBe(80);
    expect(m.gateMet).toBe(true);
  });

  it("skips rows with null label", () => {
    const rows: Row[] = [
      { status: "executed", operator_label: null },
      { status: "executed", operator_label: "good" },
    ];
    const m = computeAgreement(rows);
    expect(m.total).toBe(1);
    expect(m.agree).toBe(1);
  });
});

describe("action_log labeling schema migration", () => {
  let d: Database.Database;

  beforeEach(() => {
    d = new Database(":memory:");
  });

  afterEach(() => {
    d.close();
  });

  it("accepts operator_label + labeled_at + label_note columns", () => {
    // Create minimal action_log with Phase 2 columns
    d.exec(`
      CREATE TABLE action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE NOT NULL,
        decision_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        operator_label TEXT,
        labeled_at TEXT,
        label_note TEXT
      );
    `);

    d.prepare(
      `INSERT INTO action_log
       (idempotency_key, decision_id, kind, payload_json, mode, status, operator_label, labeled_at, label_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    ).run("k1", "d1", "like", "{}", "shadow", "executed", "good", "looks right");

    const row = d
      .prepare("SELECT operator_label, label_note FROM action_log WHERE idempotency_key = 'k1'")
      .get() as { operator_label: string; label_note: string };

    expect(row.operator_label).toBe("good");
    expect(row.label_note).toBe("looks right");
  });

  it("ensureColumn-style migration adds operator_label to existing table", () => {
    // Simulate pre-Phase-2 schema
    d.exec(`
      CREATE TABLE action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE NOT NULL,
        decision_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    const colsBefore = d.pragma("table_info(action_log)") as Array<{ name: string }>;
    expect(colsBefore.some((c) => c.name === "operator_label")).toBe(false);

    // Apply migration
    d.exec("ALTER TABLE action_log ADD COLUMN operator_label TEXT");
    d.exec("ALTER TABLE action_log ADD COLUMN labeled_at TEXT");
    d.exec("ALTER TABLE action_log ADD COLUMN label_note TEXT");

    const colsAfter = d.pragma("table_info(action_log)") as Array<{ name: string }>;
    expect(colsAfter.some((c) => c.name === "operator_label")).toBe(true);
    expect(colsAfter.some((c) => c.name === "labeled_at")).toBe(true);
    expect(colsAfter.some((c) => c.name === "label_note")).toBe(true);
  });
});
