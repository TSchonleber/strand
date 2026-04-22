import type { Command } from "commander";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { CliContext } from "../index";

/**
 * Phase 2 integration smoke test — absorbed from `scripts/smoke-shadow.ts`.
 *
 * Seeds mock mentions, runs one reasonerTick (optionally mocked via MSW),
 * evaluates the candidates through the policy gate, writes verdicts,
 * asserts non-empty candidates.
 */

const MOCK_RESPONSE = {
  id: "resp_smoke_01",
  system_fingerprint: "smoke-fp",
  output_text: JSON.stringify({
    candidates: [
      {
        action: { kind: "like", tweetId: "1001" },
        rationale:
          "Low-risk like on a mention — smoke fixture, mock response from canned MSW handler.",
        confidence: 0.9,
        relevanceScore: 0.72,
        sourceEventIds: ["mock_mention_1"],
        requiresHumanReview: false,
      },
      {
        action: {
          kind: "reply",
          tweetId: "1002",
          text: "Appreciate the tag — noted, will circle back with thoughts shortly.",
        },
        rationale: "Engagement-worthy mention from a known contact in the smoke fixture.",
        confidence: 0.78,
        relevanceScore: 0.75,
        sourceEventIds: ["mock_mention_2"],
        requiresHumanReview: false,
      },
    ],
  }),
  output: [],
  usage: {
    input_tokens: 400,
    output_tokens: 120,
    input_tokens_details: { cached_tokens: 200 },
    output_tokens_details: { reasoning_tokens: 0 },
    cost_in_usd_ticks: 85_000,
  },
};

export function registerSmokeCmd(program: Command, _ctx: CliContext): void {
  program
    .command("smoke")
    .description("shadow-mode Phase 2 integration smoke (seeds mocks, runs reasoner, asserts)")
    .option("--real-xai", "pass requests through to real xAI (requires SMOKE_REAL_XAI=1 or flag)")
    .action(async (opts: { realXai?: boolean }) => {
      // Env must be set BEFORE any @/config / @/db import.
      Object.assign(process.env, {
        NODE_ENV: process.env["NODE_ENV"] ?? "test",
        LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
        STRAND_MODE: "shadow",
        XAI_API_KEY: process.env["XAI_API_KEY"] ?? "test-smoke-key",
        X_CLIENT_ID: process.env["X_CLIENT_ID"] ?? "test-smoke",
        X_CLIENT_SECRET: process.env["X_CLIENT_SECRET"] ?? "test-smoke",
        DATABASE_PATH: process.env["DATABASE_PATH"] ?? ":memory:",
      });

      const useRealXai = opts.realXai === true || process.env["SMOKE_REAL_XAI"] === "1";
      const server = useRealXai
        ? null
        : setupServer(
            http.post("https://api.x.ai/v1/responses", () => HttpResponse.json(MOCK_RESPONSE)),
          );
      server?.listen({ onUnhandledRequest: "bypass" });

      const t0 = Date.now();
      const { db } = await import("@/db");
      const { reasonerTick } = await import("@/loops/reasoner");
      const { evaluate, makeGate } = await import("@/policy");
      const { proposed } = await import("@/types/actions");
      const { log } = await import("@/util/log");

      const dbh = db();
      for (let i = 1; i <= 3; i++) {
        dbh
          .prepare(
            "INSERT OR IGNORE INTO perceived_events (id, kind, payload_json) VALUES (?, ?, ?)",
          )
          .run(
            `mock_mention_${i}`,
            "mention",
            JSON.stringify({
              kind: "mention",
              id: `mock_mention_${i}`,
              tweetId: String(1000 + i),
              authorId: `user_mock_${i}`,
              authorHandle: "",
              text: `smoke mention ${i} — is Strand still perceiving?`,
              createdAt: new Date().toISOString(),
            }),
          );
      }
      log.info({ seeded: 3 }, "smoke.seed_mentions");

      const candidates = await reasonerTick();
      log.info({ count: candidates.length }, "smoke.reasoner_result");

      if (candidates.length < 1) {
        log.error({}, "smoke.fail.no_candidates");
        server?.close();
        process.exit(1);
      }

      const gate = makeGate();
      let approved = 0;
      let rejected = 0;

      for (const c of candidates) {
        const verdict = evaluate(gate, proposed(c));
        if (verdict.approved) {
          approved++;
          log.info(
            { kind: c.action.kind, decisionId: verdict.cacheableDecisionId },
            "smoke.approved",
          );
        } else {
          rejected++;
          log.info({ kind: c.action.kind, reasons: verdict.reasons }, "smoke.rejected");
        }
        dbh
          .prepare(
            `INSERT INTO action_log (idempotency_key, decision_id, kind, payload_json, rationale, confidence, relevance, target_entity_id, mode, status, reasons_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shadow', ?, ?)`,
          )
          .run(
            `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            verdict.approved ? verdict.cacheableDecisionId : (c.modelResponseId ?? "smoke_no_resp"),
            c.action.kind,
            JSON.stringify(c.action),
            c.rationale,
            c.confidence,
            c.relevanceScore,
            c.targetEntityId ?? null,
            verdict.approved ? "approved" : "rejected",
            verdict.approved
              ? null
              : JSON.stringify({ reasons: verdict.reasons, ruleIds: verdict.ruleIds }),
          );
      }

      log.info(
        {
          candidates: candidates.length,
          approved,
          rejected,
          durationMs: Date.now() - t0,
        },
        "smoke.ok",
      );

      server?.close();
      process.exit(0);
    });
}
