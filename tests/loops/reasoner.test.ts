import { closeDb, db } from "@/db";
import { reasonerTick } from "@/loops/reasoner";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Reasoner unit tests.
 *
 * Strategy:
 *  - MSW intercepts POST https://api.x.ai/v1/responses at the fetch layer
 *    (OpenAI SDK v4+ uses fetch on Node >=18).
 *  - Each test pushes its own sequence of handlers onto the server. The
 *    Responses API is called once on the happy path and twice on the
 *    stuck-mid-thought retry path — we verify that via handler call-count.
 *  - DB is the real `db()` singleton against ":memory:" so INSERTs exercise
 *    the full path. Since Subagent D owns schema.sql, we create
 *    `reasoner_runs` inline here with the agreed column layout.
 */

const XAI_RESPONSES = "https://api.x.ai/v1/responses";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

beforeEach(() => {
  closeDb();
  const d = db();
  d.exec(`
    CREATE TABLE IF NOT EXISTS reasoner_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      response_id TEXT,
      previous_response_id TEXT,
      candidate_count INTEGER,
      tool_call_count INTEGER,
      usage_json TEXT,
      cost_in_usd_ticks INTEGER,
      stuck_mid_thought INTEGER
    )
  `);
});

afterEach(() => {
  server.resetHandlers();
  closeDb();
});

// ─── Helpers ─────────────────────────────────────────────────

interface MockUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost_in_usd_ticks?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function mockResponse(args: {
  id?: string;
  candidates: Array<Record<string, unknown>>;
  toolCalls?: Array<{ name: string; args?: unknown }>;
  usage?: MockUsage;
}): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];
  for (const tc of args.toolCalls ?? []) {
    output.push({ type: "function_call", name: tc.name, arguments: tc.args ?? {} });
  }
  output.push({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify({ candidates: args.candidates }) }],
  });
  return {
    id: args.id ?? "resp_test_1",
    system_fingerprint: "fp_test",
    output_text: JSON.stringify({ candidates: args.candidates }),
    output,
    usage: args.usage ?? {
      input_tokens: 100,
      output_tokens: 50,
      cost_in_usd_ticks: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 10 },
    },
  };
}

function validLikeCandidate() {
  return {
    action: { kind: "like", tweetId: "tw_1" },
    rationale: "aligns with current topics",
    confidence: 0.9,
    relevanceScore: 0.82,
    sourceEventIds: ["ev_1"],
    requiresHumanReview: false,
  };
}

function validReplyCandidate() {
  return {
    action: {
      kind: "reply",
      tweetId: "tw_2",
      text: "depends on the harness. with a world-model you can hold a 40-step task for ~90m.",
    },
    rationale: "target is debating agent memory; we have shipped perspective",
    confidence: 0.88,
    relevanceScore: 0.78,
    sourceEventIds: ["ev_2"],
    requiresHumanReview: false,
  };
}

function invalidReplyCandidate() {
  // reply kind without `text` — Zod drops it
  return {
    action: { kind: "reply", tweetId: "tw_3" },
    rationale: "missing text field",
    confidence: 0.7,
    relevanceScore: 0.7,
    sourceEventIds: ["ev_3"],
    requiresHumanReview: false,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("reasonerTick", () => {
  it("happy path: returns valid candidates and writes a reasoner_runs row", async () => {
    let callCount = 0;
    server.use(
      http.post(XAI_RESPONSES, () => {
        callCount++;
        return HttpResponse.json(
          mockResponse({ candidates: [validLikeCandidate(), validReplyCandidate()] }),
        );
      }),
    );

    const out = await reasonerTick();
    expect(out).toHaveLength(2);
    expect(callCount).toBe(1);

    const row = db().prepare("SELECT * FROM reasoner_runs ORDER BY id DESC LIMIT 1").get() as {
      candidate_count: number;
      stuck_mid_thought: number;
      tool_call_count: number;
      response_id: string;
    };
    expect(row.candidate_count).toBe(2);
    expect(row.stuck_mid_thought).toBe(0);
    expect(row.tool_call_count).toBe(0);
    expect(row.response_id).toBe("resp_test_1");

    // Candidates carry modelResponseId
    expect(out[0]?.modelResponseId).toBe("resp_test_1");
  });

  it("drops malformed candidates with a warn and returns only the valid ones", async () => {
    server.use(
      http.post(XAI_RESPONSES, () =>
        HttpResponse.json(
          mockResponse({
            candidates: [validLikeCandidate(), invalidReplyCandidate(), validReplyCandidate()],
          }),
        ),
      ),
    );

    const out = await reasonerTick();
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.action.kind).sort()).toEqual(["like", "reply"]);

    const row = db()
      .prepare("SELECT candidate_count FROM reasoner_runs ORDER BY id DESC LIMIT 1")
      .get() as { candidate_count: number };
    expect(row.candidate_count).toBe(2);
  });

  it("stuck mid-thought: empty candidates + tool calls → agentic loop iterates to finish", async () => {
    // Semantics under runAgenticLoop:
    //   First chat returns tool_calls with no final candidates → loop
    //   records tool results (unknown_tool or executor output) in role:"tool"
    //   messages and re-chats. Second chat returns the final candidates.
    //   `previous_response_id` is no longer used — history lives in the
    //   caller-supplied messages array.
    let callCount = 0;
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(XAI_RESPONSES, async ({ request }) => {
        callCount++;
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        if (callCount === 1) {
          return HttpResponse.json(
            mockResponse({
              id: "resp_first",
              candidates: [],
              toolCalls: [{ name: "brainctl.memory_search", args: { query: "x" } }],
            }),
          );
        }
        return HttpResponse.json(
          mockResponse({ id: "resp_second", candidates: [validLikeCandidate()] }),
        );
      }),
    );

    const out = await reasonerTick();
    expect(callCount).toBe(2);
    expect(out).toHaveLength(1);

    // Second call's input must include the assistant's tool_call turn + the
    // synthesized tool result — history-based continuation, not prev_resp_id.
    const secondInput = bodies[1]?.["input"] as Array<Record<string, unknown>>;
    expect(Array.isArray(secondInput)).toBe(true);
    const hasFunctionCall = secondInput.some((item) => item["type"] === "function_call");
    const hasFunctionResult = secondInput.some((item) => item["type"] === "function_call_output");
    expect(hasFunctionCall).toBe(true);
    expect(hasFunctionResult).toBe(true);

    const row = db()
      .prepare(
        "SELECT stuck_mid_thought, previous_response_id, response_id, candidate_count FROM reasoner_runs ORDER BY id DESC LIMIT 1",
      )
      .get() as {
      stuck_mid_thought: number;
      previous_response_id: string | null;
      response_id: string;
      candidate_count: number;
    };
    expect(row.stuck_mid_thought).toBe(1);
    expect(row.previous_response_id).toBeNull();
    expect(row.response_id).toBe("resp_second");
    expect(row.candidate_count).toBe(1);
  });

  it("empty candidates + no tool calls: no retry, inserts row with candidate_count=0", async () => {
    let callCount = 0;
    server.use(
      http.post(XAI_RESPONSES, () => {
        callCount++;
        return HttpResponse.json(mockResponse({ candidates: [] }));
      }),
    );

    const out = await reasonerTick();
    expect(callCount).toBe(1);
    expect(out).toHaveLength(0);

    const row = db()
      .prepare(
        "SELECT candidate_count, stuck_mid_thought FROM reasoner_runs ORDER BY id DESC LIMIT 1",
      )
      .get() as { candidate_count: number; stuck_mid_thought: number };
    expect(row.candidate_count).toBe(0);
    expect(row.stuck_mid_thought).toBe(0);
  });

  it("xAI 500: returns [] and does NOT insert a reasoner_runs row", async () => {
    server.use(
      http.post(XAI_RESPONSES, () =>
        HttpResponse.json({ error: { message: "internal" } }, { status: 500 }),
      ),
    );

    const out = await reasonerTick();
    expect(out).toHaveLength(0);

    const count = (db().prepare("SELECT COUNT(*) AS n FROM reasoner_runs").get() as { n: number })
      .n;
    expect(count).toBe(0);
  });

  it("Phase 2: caps candidates at 5 even when model returns more", async () => {
    // Build 8 distinct valid candidates
    const extraCandidates = Array.from({ length: 8 }, (_, i) => ({
      action: { kind: "like", tweetId: `tw_cap_${i}` },
      rationale: `reason ${i}`,
      confidence: 0.9,
      relevanceScore: 0.8,
      sourceEventIds: [`ev_${i}`],
      requiresHumanReview: false,
    }));

    server.use(
      http.post(XAI_RESPONSES, () =>
        HttpResponse.json(mockResponse({ candidates: extraCandidates })),
      ),
    );

    const out = await reasonerTick();
    expect(out).toHaveLength(5); // hard cap
    // First 5 kept deterministically (model's own ranking)
    expect(out.map((c) => (c.action.kind === "like" ? c.action.tweetId : null))).toEqual([
      "tw_cap_0",
      "tw_cap_1",
      "tw_cap_2",
      "tw_cap_3",
      "tw_cap_4",
    ]);

    const row = db()
      .prepare("SELECT candidate_count FROM reasoner_runs ORDER BY id DESC LIMIT 1")
      .get() as { candidate_count: number };
    expect(row.candidate_count).toBe(5);
  });

  it("integration: reply with relevanceScore ≥ 0.72 round-trips end-to-end", async () => {
    server.use(
      http.post(XAI_RESPONSES, () =>
        HttpResponse.json(
          mockResponse({
            candidates: [
              {
                action: {
                  kind: "reply",
                  tweetId: "tw_integ",
                  text: "pgvector holds up to ~10M rows; past that a dedicated engine wins.",
                },
                rationale: "thread debating embedding store scale; we have direct benchmark data",
                confidence: 0.86,
                relevanceScore: 0.75,
                sourceEventIds: ["ev_integ"],
                requiresHumanReview: false,
                targetEntityId: "ent:u_5",
              },
            ],
          }),
        ),
      ),
    );

    const out = await reasonerTick();
    expect(out).toHaveLength(1);
    const c = out[0];
    if (!c) throw new Error("expected a candidate");
    expect(c.action.kind).toBe("reply");
    expect(c.relevanceScore).toBeGreaterThanOrEqual(0.72);
    expect(c.targetEntityId).toBe("ent:u_5");
    if (c.action.kind === "reply") {
      expect(c.action.text.length).toBeGreaterThan(0);
    }
  });
});
