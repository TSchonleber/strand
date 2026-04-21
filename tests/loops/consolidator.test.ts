import { closeDb, db } from "@/db";
import { consolidatorPoll, consolidatorRunWithResult } from "@/loops/consolidator";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureConsolidatorRunsTable } from "../helpers/consolidator-schema";

/**
 * Consolidator Batch API pipeline tests.
 *
 * MSW intercepts xAI's /v1/files, /v1/batches, /v1/batches/:id,
 * /v1/files/:id/content, and a direct result URL shape (some xAI responses
 * return output_file_url instead of output_file_id).
 *
 * Subagent D owns the consolidator_runs DDL in schema.sql; we add it
 * inline so tests pass in isolation.
 */

const BASE = "https://api.x.ai/v1";

// --- mutable MSW state, reset between tests ---
interface MockBatch {
  id: string;
  status:
    | "validating"
    | "in_progress"
    | "completed"
    | "failed"
    | "expired"
    | "cancelling"
    | "cancelled"
    | "finalizing";
  input_file_id: string;
  output_file_id?: string;
  output_file_url?: string;
  request_counts?: { total: number; completed: number; failed: number };
  created_at: number;
  endpoint: string;
  completion_window: string;
}

interface MockState {
  lastUploadedPurpose: string | null;
  lastUploadedBody: string | null;
  lastBatchCreate: Record<string, unknown> | null;
  nextFileId: string;
  nextBatchId: string;
  batches: Map<string, MockBatch>;
  fileContents: Map<string, string>;
  directResults: Map<string, string>;
}

const state: MockState = {
  lastUploadedPurpose: null,
  lastUploadedBody: null,
  lastBatchCreate: null,
  nextFileId: "file_default",
  nextBatchId: "batch_default",
  batches: new Map(),
  fileContents: new Map(),
  directResults: new Map(),
};

function resetMockState(): void {
  state.lastUploadedPurpose = null;
  state.lastUploadedBody = null;
  state.lastBatchCreate = null;
  state.nextFileId = "file_default";
  state.nextBatchId = "batch_default";
  state.batches.clear();
  state.fileContents.clear();
  state.directResults.clear();
}

function makeResponseBody(
  custom: string,
  summary: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `resp_${custom}`,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(summary) }],
      },
    ],
    output_text: JSON.stringify(summary),
  };
}

const server = setupServer(
  http.post(`${BASE}/files`, async ({ request }) => {
    // OpenAI SDK sends multipart form-data. We don't parse exhaustively — we
    // just confirm purpose + capture body text.
    const ct = request.headers.get("content-type") ?? "";
    state.lastUploadedPurpose = null;
    state.lastUploadedBody = null;
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      state.lastUploadedPurpose = String(form.get("purpose") ?? "");
      const file = form.get("file");
      if (file && typeof (file as Blob).text === "function") {
        state.lastUploadedBody = await (file as Blob).text();
      }
    }
    return HttpResponse.json({
      id: state.nextFileId,
      object: "file",
      bytes: state.lastUploadedBody?.length ?? 0,
      created_at: Math.floor(Date.now() / 1000),
      filename: "batch.jsonl",
      purpose: state.lastUploadedPurpose ?? "batch",
    });
  }),

  http.post(`${BASE}/batches`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    state.lastBatchCreate = body;
    const batch: MockBatch = {
      id: state.nextBatchId,
      status: "validating",
      input_file_id: String(body["input_file_id"] ?? ""),
      created_at: Math.floor(Date.now() / 1000),
      endpoint: String(body["endpoint"] ?? "/v1/responses"),
      completion_window: String(body["completion_window"] ?? "24h"),
      request_counts: { total: 5, completed: 0, failed: 0 },
    };
    state.batches.set(batch.id, batch);
    return HttpResponse.json({ object: "batch", ...batch });
  }),

  http.get(`${BASE}/batches/:id`, ({ params }) => {
    const id = String(params["id"]);
    const b = state.batches.get(id);
    if (!b) return new HttpResponse("not found", { status: 404 });
    return HttpResponse.json({ object: "batch", ...b });
  }),

  http.get(`${BASE}/files/:id/content`, ({ params }) => {
    const id = String(params["id"]);
    const body = state.fileContents.get(id);
    if (body === undefined) return new HttpResponse("not found", { status: 404 });
    return new HttpResponse(body, {
      status: 200,
      headers: { "content-type": "application/jsonl" },
    });
  }),

  http.get("https://results.x.ai/:id", ({ params }) => {
    const id = String(params["id"]);
    const body = state.directResults.get(id);
    if (body === undefined) return new HttpResponse("not found", { status: 404 });
    return new HttpResponse(body, {
      status: 200,
      headers: { "content-type": "application/jsonl" },
    });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  server.resetHandlers();
});

beforeEach(() => {
  resetMockState();
  closeDb();
  const d = db();
  ensureConsolidatorRunsTable(d);
});

afterEach(() => {
  closeDb();
});

describe("consolidatorRun (submit)", () => {
  it("uploads JSONL, creates a batch, inserts a queued row", async () => {
    state.nextFileId = "file_abc";
    state.nextBatchId = "batch_abc";

    const result = await consolidatorRunWithResult();
    expect(result.batchId).toBe("batch_abc");
    expect(state.lastUploadedPurpose).toBe("batch");
    expect(state.lastUploadedBody).toBeTruthy();

    // JSONL has 5 lines, one per consolidation task.
    const lines = (state.lastUploadedBody ?? "").trim().split("\n");
    expect(lines).toHaveLength(5);
    const customIds = lines.map((l) => JSON.parse(l).custom_id as string);
    expect(customIds).toEqual(
      expect.arrayContaining([
        "consolidator:dream_cycle",
        "consolidator:consolidation_run",
        "consolidator:gaps_scan",
        "consolidator:retirement_analysis",
        "consolidator:reflexion_write",
      ]),
    );

    // Every body targets /v1/responses and pins the prompt cache key.
    for (const raw of lines) {
      const parsed = JSON.parse(raw);
      expect(parsed.method).toBe("POST");
      expect(parsed.url).toBe("/v1/responses");
      expect(parsed.body.prompt_cache_key).toBe("strand:consolidator:v1");
      expect(parsed.body.max_turns).toBe(5);
      expect(parsed.body.response_format?.type).toBe("json_schema");
      // Reasoning-model param hygiene — these must never appear.
      expect(parsed.body.presence_penalty).toBeUndefined();
      expect(parsed.body.frequency_penalty).toBeUndefined();
      expect(parsed.body.stop).toBeUndefined();
      expect(parsed.body.reasoning_effort).toBeUndefined();
    }

    expect(state.lastBatchCreate).toMatchObject({
      input_file_id: "file_abc",
      endpoint: "/v1/responses",
      completion_window: "24h",
    });

    const row = db()
      .prepare(
        "SELECT id, batch_id, status, completed_at, summary_json, error FROM consolidator_runs",
      )
      .get() as {
      id: string;
      batch_id: string;
      status: string;
      completed_at: string | null;
      summary_json: string | null;
      error: string | null;
    };
    expect(row.batch_id).toBe("batch_abc");
    expect(row.status).toBe("queued");
    expect(row.id).toBe(result.runId);
    expect(row.completed_at).toBeNull();
    expect(row.summary_json).toBeNull();
    expect(row.error).toBeNull();
  });
});

describe("consolidatorPoll", () => {
  async function seedRun(batchId: string): Promise<string> {
    state.nextFileId = "file_seed";
    state.nextBatchId = batchId;
    const r = await consolidatorRunWithResult();
    return r.runId;
  }

  it("moves queued → in_progress when the batch is still running", async () => {
    const runId = await seedRun("batch_ip");
    const b = state.batches.get("batch_ip");
    if (!b) throw new Error("no batch");
    b.status = "in_progress";

    await consolidatorPoll();

    const row = db().prepare("SELECT status FROM consolidator_runs WHERE id = ?").get(runId) as {
      status: string;
    };
    expect(row.status).toBe("in_progress");
  });

  it("aggregates results and marks completed on success", async () => {
    const runId = await seedRun("batch_done");
    const b = state.batches.get("batch_done");
    if (!b) throw new Error("no batch");
    b.status = "completed";
    b.output_file_id = "file_out_done";
    b.request_counts = { total: 5, completed: 5, failed: 0 };

    const jsonlLines: string[] = [
      JSON.stringify({
        id: "l1",
        custom_id: "consolidator:dream_cycle",
        response: {
          status_code: 200,
          body: makeResponseBody("dream", {
            changed: ["dream.ran"],
            insights: [],
            gaps: [],
            retirements: [],
          }),
        },
      }),
      JSON.stringify({
        id: "l2",
        custom_id: "consolidator:consolidation_run",
        response: {
          status_code: 200,
          body: makeResponseBody("cons", {
            changed: ["promoted 3"],
            insights: ["dup cluster around @acme"],
            gaps: [],
            retirements: [],
          }),
        },
      }),
      JSON.stringify({
        id: "l3",
        custom_id: "consolidator:gaps_scan",
        response: {
          status_code: 200,
          body: makeResponseBody("gaps", {
            changed: [],
            insights: [],
            gaps: ["who is @bob?", "what is project zeta?"],
            retirements: [],
          }),
        },
      }),
      JSON.stringify({
        id: "l4",
        custom_id: "consolidator:retirement_analysis",
        response: {
          status_code: 200,
          body: makeResponseBody("ret", {
            changed: [],
            insights: [],
            gaps: [],
            retirements: ["mem_001"],
          }),
        },
      }),
      JSON.stringify({
        id: "l5",
        custom_id: "consolidator:reflexion_write",
        response: {
          status_code: 200,
          body: makeResponseBody("refl", {
            changed: ["wrote reflexion r_42"],
            insights: [],
            gaps: [],
            retirements: [],
          }),
        },
      }),
    ];
    state.fileContents.set("file_out_done", `${jsonlLines.join("\n")}\n`);

    await consolidatorPoll();

    const row = db()
      .prepare(
        "SELECT status, completed_at, summary_json, error FROM consolidator_runs WHERE id = ?",
      )
      .get(runId) as {
      status: string;
      completed_at: string | null;
      summary_json: string | null;
      error: string | null;
    };
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBeTruthy();
    expect(row.error).toBeNull();

    const summary = JSON.parse(row.summary_json ?? "{}") as {
      changed: string[];
      insights: string[];
      gaps: string[];
      retirements: string[];
      failed_tasks: string[];
    };
    expect(summary.changed).toEqual(
      expect.arrayContaining(["dream.ran", "promoted 3", "wrote reflexion r_42"]),
    );
    expect(summary.insights).toContain("dup cluster around @acme");
    expect(summary.gaps).toEqual(expect.arrayContaining(["who is @bob?", "what is project zeta?"]));
    expect(summary.retirements).toContain("mem_001");
    expect(summary.failed_tasks).toHaveLength(0);
  });

  it("marks failed when the batch status is failed", async () => {
    const runId = await seedRun("batch_fail");
    const b = state.batches.get("batch_fail");
    if (!b) throw new Error("no batch");
    b.status = "failed";
    b.request_counts = { total: 5, completed: 0, failed: 5 };

    const warnSpy = vi.fn();
    // We already wire pino to level=fatal in env.ts; reading log output back is
    // brittle. Instead we assert on row state.
    expect(warnSpy).not.toHaveBeenCalled();

    await consolidatorPoll();

    const row = db()
      .prepare("SELECT status, error FROM consolidator_runs WHERE id = ?")
      .get(runId) as { status: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
    expect(row.error ?? "").toContain("failed");
  });

  it("records partial failures (3 ok + 2 errors) and still marks completed", async () => {
    const runId = await seedRun("batch_partial");
    const b = state.batches.get("batch_partial");
    if (!b) throw new Error("no batch");
    b.status = "completed";
    b.output_file_id = "file_out_partial";
    b.request_counts = { total: 5, completed: 3, failed: 2 };

    const jsonl = [
      JSON.stringify({
        id: "l1",
        custom_id: "consolidator:dream_cycle",
        response: {
          status_code: 200,
          body: makeResponseBody("dream", {
            changed: ["d1"],
            insights: [],
            gaps: [],
            retirements: [],
          }),
        },
      }),
      JSON.stringify({
        id: "l2",
        custom_id: "consolidator:consolidation_run",
        response: {
          status_code: 200,
          body: makeResponseBody("cons", {
            changed: ["c1"],
            insights: [],
            gaps: [],
            retirements: [],
          }),
        },
      }),
      JSON.stringify({
        id: "l3",
        custom_id: "consolidator:gaps_scan",
        response: {
          status_code: 200,
          body: makeResponseBody("gaps", {
            changed: [],
            insights: [],
            gaps: ["g1"],
            retirements: [],
          }),
        },
      }),
      JSON.stringify({
        id: "l4",
        custom_id: "consolidator:retirement_analysis",
        error: { code: "tool_error", message: "retirement_analysis timed out" },
      }),
      JSON.stringify({
        id: "l5",
        custom_id: "consolidator:reflexion_write",
        error: { code: "rate_limit", message: "upstream 429" },
      }),
    ].join("\n");
    state.fileContents.set("file_out_partial", `${jsonl}\n`);

    await consolidatorPoll();

    const row = db()
      .prepare("SELECT status, summary_json, error FROM consolidator_runs WHERE id = ?")
      .get(runId) as { status: string; summary_json: string | null; error: string | null };
    expect(row.status).toBe("completed");
    expect(row.error).toBeNull();
    const summary = JSON.parse(row.summary_json ?? "{}") as {
      changed: string[];
      gaps: string[];
      failed_tasks: string[];
    };
    expect(summary.changed).toEqual(expect.arrayContaining(["d1", "c1"]));
    expect(summary.gaps).toContain("g1");
    expect(summary.failed_tasks).toHaveLength(2);
    expect(summary.failed_tasks.join(" ")).toContain("retirement_analysis");
    expect(summary.failed_tasks.join(" ")).toContain("reflexion_write");
  });

  it("supports direct output_file_url in place of output_file_id", async () => {
    const runId = await seedRun("batch_url");
    const b = state.batches.get("batch_url");
    if (!b) throw new Error("no batch");
    b.status = "completed";
    b.output_file_url = "https://results.x.ai/out_url";
    b.request_counts = { total: 1, completed: 1, failed: 0 };

    state.directResults.set(
      "out_url",
      `${JSON.stringify({
        id: "l1",
        custom_id: "consolidator:dream_cycle",
        response: {
          status_code: 200,
          body: makeResponseBody("dream", {
            changed: ["url.path"],
            insights: [],
            gaps: [],
            retirements: [],
          }),
        },
      })}\n`,
    );

    await consolidatorPoll();

    const row = db()
      .prepare("SELECT status, summary_json FROM consolidator_runs WHERE id = ?")
      .get(runId) as { status: string; summary_json: string | null };
    expect(row.status).toBe("completed");
    const summary = JSON.parse(row.summary_json ?? "{}") as { changed: string[] };
    expect(summary.changed).toContain("url.path");
  });
});

describe("consolidatorRun — inline-batch path (Anthropic-style)", () => {
  it("uses batchCreateInline (no file upload) and inserts a queued row", async () => {
    const batchCreateInlineMock = vi.fn(async ({ requests }: { requests: unknown[] }) => ({
      id: "msgbatch_inline",
      status: "in_progress" as const,
      created_at: Math.floor(Date.now() / 1000),
      request_counts: { total: requests.length, completed: 0, failed: 0 },
    }));
    const filesUploadMock = vi.fn();

    const mockProvider = {
      name: "anthropic",
      capabilities: {
        structuredOutput: true,
        mcp: true,
        serverSideTools: [] as readonly string[],
        batch: true,
        promptCacheKey: true,
        previousResponseId: false,
        functionToolLoop: true,
        computerUse: true,
        maxContextTokens: 200_000,
      },
      chat: vi.fn(),
      batchCreateInline: batchCreateInlineMock,
      batchGet: vi.fn(),
      batchResults: vi.fn(),
      buildBatchLine: (_call: unknown, customId: string) => ({
        custom_id: customId,
        method: "POST" as const,
        url: "/v1/messages",
        body: {
          model: "claude-sonnet-4-5-20250514",
          max_tokens: 2000,
          messages: [{ role: "user", content: "x" }],
        },
      }),
      filesUpload: filesUploadMock,
    };

    const llmModule = await import("@/clients/llm");
    const llmSpy = vi.spyOn(llmModule, "llm").mockReturnValue(mockProvider as never);

    try {
      const { consolidatorRunWithResult } = await import("@/loops/consolidator");
      const result = await consolidatorRunWithResult();

      expect(result.batchId).toBe("msgbatch_inline");
      expect(filesUploadMock).not.toHaveBeenCalled();
      expect(batchCreateInlineMock).toHaveBeenCalledTimes(1);

      const args = batchCreateInlineMock.mock.calls[0]?.[0] as {
        requests: Array<{ custom_id: string; body: Record<string, unknown> }>;
      };
      expect(args.requests).toHaveLength(5);
      const customIds = args.requests.map((r) => r.custom_id);
      expect(customIds).toEqual(
        expect.arrayContaining([
          "consolidator:dream_cycle",
          "consolidator:consolidation_run",
          "consolidator:gaps_scan",
          "consolidator:retirement_analysis",
          "consolidator:reflexion_write",
        ]),
      );
      // body shape is Anthropic-native (no method/url envelope leaked).
      expect(args.requests[0]?.body?.["model"]).toBe("claude-sonnet-4-5-20250514");
      expect(args.requests[0]?.body?.["method"]).toBeUndefined();
      expect(args.requests[0]?.body?.["url"]).toBeUndefined();

      const row = db()
        .prepare(
          "SELECT id, batch_id, status, completed_at, summary_json FROM consolidator_runs WHERE id = ?",
        )
        .get(result.runId) as {
        id: string;
        batch_id: string;
        status: string;
        completed_at: string | null;
        summary_json: string | null;
      };
      expect(row.batch_id).toBe("msgbatch_inline");
      expect(row.status).toBe("queued");
      expect(row.completed_at).toBeNull();
      expect(row.summary_json).toBeNull();
    } finally {
      llmSpy.mockRestore();
    }
  });
});

describe("consolidatorRun — sync fallback (Anthropic-style, no batch)", () => {
  it("runs every task via provider.chat() and stores completed row with local: batch id", async () => {
    const chatMock = vi.fn(async () => ({
      outputText: JSON.stringify({
        changed: ["synced.one"],
        insights: [],
        gaps: ["why?"],
        retirements: [],
      }),
      parsed: {
        changed: ["synced.one"],
        insights: [],
        gaps: ["why?"],
        retirements: [],
      },
      responseId: "resp_mock",
      systemFingerprint: null,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costInUsdTicks: 0,
      },
      toolCalls: [],
      rawResponse: {},
    }));

    const mockProvider = {
      name: "anthropic",
      capabilities: {
        structuredOutput: true,
        mcp: true,
        serverSideTools: [] as readonly string[],
        batch: false,
        promptCacheKey: true,
        previousResponseId: false,
        functionToolLoop: true,
        computerUse: true,
        maxContextTokens: 200_000,
      },
      chat: chatMock,
    };

    const llmModule = await import("@/clients/llm");
    const llmSpy = vi.spyOn(llmModule, "llm").mockReturnValue(mockProvider as never);

    try {
      const { consolidatorRunWithResult } = await import("@/loops/consolidator");
      const result = await consolidatorRunWithResult();
      expect(result.batchId.startsWith("local:")).toBe(true);
      expect(chatMock).toHaveBeenCalledTimes(5);

      const row = db()
        .prepare(
          "SELECT status, batch_id, summary_json, completed_at FROM consolidator_runs WHERE id = ?",
        )
        .get(result.runId) as {
        status: string;
        batch_id: string;
        summary_json: string | null;
        completed_at: string | null;
      };
      expect(row.status).toBe("completed");
      expect(row.batch_id.startsWith("local:")).toBe(true);
      expect(row.completed_at).toBeTruthy();

      const summary = JSON.parse(row.summary_json ?? "{}") as {
        changed: string[];
        gaps: string[];
        failed_tasks: string[];
      };
      expect(summary.changed.filter((c) => c === "synced.one")).toHaveLength(5);
      expect(summary.gaps.filter((g) => g === "why?")).toHaveLength(5);
      expect(summary.failed_tasks).toHaveLength(0);
    } finally {
      llmSpy.mockRestore();
    }
  });

  it("records failed_tasks when chat() throws but still completes", async () => {
    let calls = 0;
    const chatMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider boom");
      return {
        outputText: "",
        parsed: {
          changed: ["ok"],
          insights: [],
          gaps: [],
          retirements: [],
        },
        responseId: "resp",
        systemFingerprint: null,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          costInUsdTicks: 0,
        },
        toolCalls: [],
        rawResponse: {},
      };
    });

    const mockProvider = {
      name: "anthropic",
      capabilities: {
        structuredOutput: true,
        mcp: true,
        serverSideTools: [] as readonly string[],
        batch: false,
        promptCacheKey: true,
        previousResponseId: false,
        functionToolLoop: true,
        computerUse: true,
        maxContextTokens: 200_000,
      },
      chat: chatMock,
    };

    const llmModule = await import("@/clients/llm");
    const llmSpy = vi.spyOn(llmModule, "llm").mockReturnValue(mockProvider as never);

    try {
      const { consolidatorRunWithResult } = await import("@/loops/consolidator");
      const result = await consolidatorRunWithResult();
      const row = db()
        .prepare("SELECT status, summary_json FROM consolidator_runs WHERE id = ?")
        .get(result.runId) as { status: string; summary_json: string | null };
      expect(row.status).toBe("completed");
      const summary = JSON.parse(row.summary_json ?? "{}") as {
        changed: string[];
        failed_tasks: string[];
      };
      expect(summary.failed_tasks).toHaveLength(1);
      expect(summary.failed_tasks[0]).toContain("provider boom");
      expect(summary.changed).toEqual(expect.arrayContaining(["ok"]));
    } finally {
      llmSpy.mockRestore();
    }
  });
});
