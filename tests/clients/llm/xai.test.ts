import type { LlmTool } from "@/clients/llm/types";
import { makeXaiProvider } from "@/clients/llm/xai";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * xAI adapter tests. MSW intercepts api.x.ai. Verifies that the adapter
 * correctly translates LlmCall → legacy GrokCallInput → on-wire body, and
 * translates the xAI response back into a normalized LlmResult.
 */

const RESPONSES_URL = "https://api.x.ai/v1/responses";
const FILES_URL = "https://api.x.ai/v1/files";
const BATCHES_URL = "https://api.x.ai/v1/batches";

interface CapturedResponsesCall {
  body: Record<string, unknown>;
}

let responsesCalls: CapturedResponsesCall[] = [];
let nextResponse: Record<string, unknown> | null = null;
let nextBatchGet: Record<string, unknown> | null = null;
let nextBatchResults: string | null = null;

const DEFAULT_USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 80 },
  output_tokens: 40,
  output_tokens_details: { reasoning_tokens: 5 },
  cost_in_usd_ticks: 9999,
};

function defaultResponseBody(): Record<string, unknown> {
  return {
    id: "resp_xai_1",
    system_fingerprint: "fp_xai_1",
    output_text: "hello world",
    output: [],
    usage: { ...DEFAULT_USAGE },
  };
}

const server = setupServer(
  http.post(RESPONSES_URL, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    responsesCalls.push({ body });
    return HttpResponse.json(nextResponse ?? defaultResponseBody());
  }),
  http.post(FILES_URL, async () => {
    return HttpResponse.json({ id: "file_batch_1", object: "file", purpose: "batch" });
  }),
  http.post(BATCHES_URL, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      id: "batch_1",
      status: "in_progress",
      input_file_id: body["input_file_id"],
      created_at: 1700000000,
      endpoint: body["endpoint"],
      completion_window: body["completion_window"] ?? "24h",
    });
  }),
  http.get(`${BATCHES_URL}/:id`, ({ params }) => {
    return HttpResponse.json(
      nextBatchGet ?? {
        id: params["id"],
        status: "completed",
        input_file_id: "file_batch_1",
        output_file_id: "file_out_1",
        created_at: 1700000000,
        completed_at: 1700000900,
        request_counts: { total: 2, completed: 2, failed: 0 },
      },
    );
  }),
  http.get("https://api.x.ai/v1/files/:id/content", () => {
    const text =
      nextBatchResults ??
      [
        JSON.stringify({
          id: "line_1",
          custom_id: "t1",
          response: { status_code: 200, body: { id: "resp_a", output_text: "a" } },
        }),
        JSON.stringify({
          id: "line_2",
          custom_id: "t2",
          response: { status_code: 200, body: { id: "resp_b", output_text: "b" } },
        }),
      ].join("\n");
    return HttpResponse.text(text);
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  responsesCalls = [];
  nextResponse = null;
  nextBatchGet = null;
  nextBatchResults = null;
});

afterEach(() => {
  server.resetHandlers(
    http.post(RESPONSES_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      responsesCalls.push({ body });
      return HttpResponse.json(nextResponse ?? defaultResponseBody());
    }),
    http.post(FILES_URL, async () => {
      return HttpResponse.json({ id: "file_batch_1", object: "file", purpose: "batch" });
    }),
    http.post(BATCHES_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: "batch_1",
        status: "in_progress",
        input_file_id: body["input_file_id"],
        created_at: 1700000000,
        endpoint: body["endpoint"],
        completion_window: body["completion_window"] ?? "24h",
      });
    }),
    http.get(`${BATCHES_URL}/:id`, ({ params }) => {
      return HttpResponse.json(
        nextBatchGet ?? {
          id: params["id"],
          status: "completed",
          input_file_id: "file_batch_1",
          output_file_id: "file_out_1",
          created_at: 1700000000,
          completed_at: 1700000900,
          request_counts: { total: 2, completed: 2, failed: 0 },
        },
      );
    }),
    http.get("https://api.x.ai/v1/files/:id/content", () => {
      const text =
        nextBatchResults ??
        [
          JSON.stringify({
            id: "line_1",
            custom_id: "t1",
            response: { status_code: 200, body: { id: "resp_a", output_text: "a" } },
          }),
          JSON.stringify({
            id: "line_2",
            custom_id: "t2",
            response: { status_code: 200, body: { id: "resp_b", output_text: "b" } },
          }),
        ].join("\n");
      return HttpResponse.text(text);
    }),
  );
});

function makeProvider() {
  return makeXaiProvider({ apiKey: "test-xai-key" });
}

describe("makeXaiProvider — capabilities", () => {
  it("declares the xAI feature matrix", () => {
    const p = makeProvider();
    expect(p.name).toBe("xai");
    expect(p.capabilities.structuredOutput).toBe(true);
    expect(p.capabilities.mcp).toBe(true);
    expect(p.capabilities.batch).toBe(true);
    expect(p.capabilities.promptCacheKey).toBe(true);
    expect(p.capabilities.previousResponseId).toBe(true);
    expect(p.capabilities.serverSideTools).toEqual(["x_search", "web_search", "code_interpreter"]);
  });
});

describe("makeXaiProvider.chat", () => {
  it("simple chat normalizes outputText + usage", async () => {
    const p = makeProvider();
    const r = await p.chat({
      model: "grok-4-1-fast-non-reasoning",
      messages: [{ role: "user", content: "hi there" }],
    });
    expect(r.outputText).toBe("hello world");
    expect(r.responseId).toBe("resp_xai_1");
    expect(r.systemFingerprint).toBe("fp_xai_1");
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.cachedInputTokens).toBe(80);
    expect(r.usage.outputTokens).toBe(40);
    expect(r.usage.reasoningTokens).toBe(5);
    expect(r.usage.costInUsdTicks).toBe(9999);
    expect(responsesCalls).toHaveLength(1);
  });

  it("structured output populates parsed", async () => {
    nextResponse = {
      id: "resp_2",
      system_fingerprint: "fp_2",
      output_text: JSON.stringify({ kind: "ok", n: 7 }),
      output: [],
      usage: { ...DEFAULT_USAGE },
    };
    const p = makeProvider();
    const r = await p.chat<{ kind: string; n: number }>({
      model: "grok-4-1-fast-non-reasoning",
      messages: [{ role: "user", content: "emit json" }],
      structuredOutput: {
        name: "result",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { kind: { type: "string" }, n: { type: "number" } },
          required: ["kind", "n"],
        },
        strict: true,
      },
    });
    expect(r.parsed).toEqual({ kind: "ok", n: 7 });

    const body = responsesCalls[0]?.body as Record<string, unknown>;
    const rf = body["response_format"] as Record<string, unknown>;
    expect(rf["type"]).toBe("json_schema");
    const js = rf["json_schema"] as Record<string, unknown>;
    expect(js["name"]).toBe("result");
    expect(js["strict"]).toBe(true);
  });

  it("splits system messages into systemPrompts and user messages into userInput", async () => {
    const p = makeProvider();
    await p.chat({
      model: "grok-4-1-fast-non-reasoning",
      messages: [
        { role: "system", content: "persona block" },
        { role: "system", content: "policies block" },
        { role: "user", content: "the task" },
      ],
    });
    const body = responsesCalls[0]?.body as Record<string, unknown>;
    const input = body["input"] as Array<{ role: string; content: string }>;
    expect(input).toEqual([
      { role: "system", content: "persona block" },
      { role: "system", content: "policies block" },
      { role: "user", content: "the task" },
    ]);
  });

  it("preserves multi-turn assistant/user history natively (no prefix collapse)", async () => {
    const p = makeProvider();
    await p.chat({
      model: "grok-4-1-fast-non-reasoning",
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    });
    const body = responsesCalls[0]?.body as Record<string, unknown>;
    const input = body["input"] as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { role: "system", content: "be concise" },
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
  });

  it("emits assistant toolCalls as function_call items with call_id", async () => {
    const p = makeProvider();
    await p.chat({
      model: "grok-4.20-reasoning",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "please search" },
        {
          role: "assistant",
          content: "looking it up",
          toolCalls: [
            { id: "call_abc", name: "memory_search", args: { q: "roadmap" } },
            { id: "call_def", name: "entity_search", args: { q: "Terrence" } },
          ],
        },
      ],
    });
    const body = responsesCalls[0]?.body as Record<string, unknown>;
    const input = body["input"] as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ role: "system", content: "sys" });
    expect(input[1]).toEqual({ role: "user", content: "please search" });
    // assistant text preserved as its own message, preceding the calls
    expect(input[2]).toEqual({ role: "assistant", content: "looking it up" });
    expect(input[3]).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
      name: "memory_search",
      id: "call_abc",
    });
    expect(JSON.parse(String(input[3]?.["arguments"]))).toEqual({ q: "roadmap" });
    expect(input[4]).toMatchObject({
      type: "function_call",
      call_id: "call_def",
      name: "entity_search",
    });
    expect(JSON.parse(String(input[4]?.["arguments"]))).toEqual({ q: "Terrence" });
  });

  it("emits tool-role messages as function_call_output keyed by toolCallId", async () => {
    const p = makeProvider();
    await p.chat({
      model: "grok-4.20-reasoning",
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_abc", name: "memory_search", args: { q: "x" } }],
        },
        {
          role: "tool",
          toolCallId: "call_abc",
          content: '{"results":[{"id":1,"content":"fact"}]}',
        },
        { role: "user", content: "summarize" },
      ],
    });
    const body = responsesCalls[0]?.body as Record<string, unknown>;
    const input = body["input"] as Array<Record<string, unknown>>;
    // [user, function_call, function_call_output, user]
    expect(input).toHaveLength(4);
    expect(input[0]).toEqual({ role: "user", content: "do it" });
    expect(input[1]?.["type"]).toBe("function_call");
    expect(input[1]?.["call_id"]).toBe("call_abc");
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_abc",
      output: '{"results":[{"id":1,"content":"fact"}]}',
    });
    expect(input[3]).toEqual({ role: "user", content: "summarize" });
  });

  it("preserves tool-call id from xAI function_call response items", async () => {
    nextResponse = {
      id: "resp_tc",
      system_fingerprint: "fp_tc",
      output_text: "",
      output: [
        {
          type: "function_call",
          id: "fc_ignored",
          call_id: "call_xyz",
          name: "memory_search",
          arguments: '{"q":"hi"}',
        },
      ],
      usage: { ...DEFAULT_USAGE },
    };
    const p = makeProvider();
    const r = await p.chat({
      model: "grok-4.20-reasoning",
      messages: [{ role: "user", content: "search" }],
    });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.id).toBe("call_xyz");
    expect(r.toolCalls[0]?.name).toBe("memory_search");
    expect(r.toolCalls[0]?.args).toBe('{"q":"hi"}');
  });

  it("passes through x_search + mcp tools in request body", async () => {
    const p = makeProvider();
    const tools: LlmTool[] = [
      { type: "x_search", allowed_x_handles: ["elonmusk"] },
      {
        type: "mcp",
        server_label: "brainctl",
        server_url: "https://brain.example.com/mcp",
        authorization: "Bearer X",
        allowed_tools: ["memory_search"],
      },
    ];
    await p.chat({
      model: "grok-4.20-reasoning",
      messages: [{ role: "user", content: "use tools" }],
      tools,
      parallelToolCalls: true,
      maxTurns: 5,
    });
    const body = responsesCalls[0]?.body as Record<string, unknown>;
    const sentTools = body["tools"] as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(2);
    expect(sentTools[0]?.["type"]).toBe("x_search");
    expect(sentTools[0]?.["allowed_x_handles"]).toEqual(["elonmusk"]);
    expect(sentTools[1]?.["type"]).toBe("mcp");
    expect(sentTools[1]?.["server_label"]).toBe("brainctl");
    expect(sentTools[1]?.["allowed_tools"]).toEqual(["memory_search"]);
    expect(body["parallel_tool_calls"]).toBe(true);
    expect(body["max_turns"]).toBe(5);
  });

  it("passes promptCacheKey + include through as snake_case", async () => {
    const p = makeProvider();
    await p.chat({
      model: "grok-4.20-reasoning",
      messages: [{ role: "user", content: "cache me" }],
      promptCacheKey: "strand:reasoner:v9",
      include: ["mcp_call_output", "reasoning.encrypted_content", "unknown_include_drop_me"],
    });
    const body = responsesCalls[0]?.body as Record<string, unknown>;
    expect(body["prompt_cache_key"]).toBe("strand:reasoner:v9");
    const include = body["include"] as string[];
    expect(include).toEqual(["mcp_call_output", "reasoning.encrypted_content"]);
  });

  it("passes previous_response_id for stored-conversation chaining", async () => {
    const p = makeProvider();
    await p.chat({
      model: "grok-4.20-reasoning",
      messages: [{ role: "user", content: "continue" }],
      previousResponseId: "resp_prior_abc",
    });
    const body = responsesCalls[0]?.body as Record<string, unknown>;
    expect(body["previous_response_id"]).toBe("resp_prior_abc");
  });
});

describe("makeXaiProvider.buildBatchLine", () => {
  it("returns a /v1/responses line with the snake_case body shape", () => {
    const p = makeProvider();
    if (!p.buildBatchLine) throw new Error("xai provider missing buildBatchLine");

    const line = p.buildBatchLine(
      {
        model: "grok-4.20-reasoning",
        messages: [
          { role: "system", content: "persona" },
          { role: "user", content: "Task: foo" },
        ],
        maxOutputTokens: 500,
        maxTurns: 5,
        promptCacheKey: "strand:consolidator:v1",
        include: ["mcp_call_output", "reasoning.encrypted_content"],
        structuredOutput: {
          name: "summary",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
          strict: true,
        },
      },
      "c1",
    );

    expect(line.custom_id).toBe("c1");
    expect(line.method).toBe("POST");
    expect(line.url).toBe("/v1/responses");
    expect(line.body["model"]).toBe("grok-4.20-reasoning");
    expect(line.body["max_output_tokens"]).toBe(500);
    expect(line.body["max_turns"]).toBe(5);
    expect(line.body["prompt_cache_key"]).toBe("strand:consolidator:v1");
    expect(line.body["include"]).toEqual(["mcp_call_output", "reasoning.encrypted_content"]);
    const rf = line.body["response_format"] as Record<string, unknown>;
    expect(rf["type"]).toBe("json_schema");
    const input = line.body["input"] as Array<{ role: string; content: string }>;
    expect(input[0]).toEqual({ role: "system", content: "persona" });
    expect(input[1]?.role).toBe("user");
    // Reasoning-model param hygiene.
    expect(line.body["presence_penalty"]).toBeUndefined();
    expect(line.body["frequency_penalty"]).toBeUndefined();
    expect(line.body["stop"]).toBeUndefined();
    expect(line.body["reasoning_effort"]).toBeUndefined();
    expect(line.body["temperature"]).toBeUndefined();
  });
});

describe("makeXaiProvider batch round-trip", () => {
  it("uploads JSONL, creates batch, fetches handle, streams results", async () => {
    const p = makeProvider();
    if (!p.filesUpload || !p.batchCreate || !p.batchGet || !p.batchResults) {
      throw new Error("batch methods missing");
    }

    const file = await p.filesUpload(
      `${JSON.stringify({ custom_id: "t1", method: "POST", url: "/v1/responses", body: {} })}\n`,
      "batch",
    );
    expect(file.id).toBe("file_batch_1");

    const handle = await p.batchCreate({
      inputFileId: file.id,
      endpoint: "/v1/responses",
      completionWindow: "24h",
    });
    expect(handle.id).toBe("batch_1");
    expect(handle.input_file_id).toBe("file_batch_1");

    const fetched = await p.batchGet(handle.id);
    expect(fetched.id).toBe("batch_1");
    expect(fetched.status).toBe("completed");
    expect(fetched.output_file_id).toBe("file_out_1");
    expect(fetched.request_counts).toEqual({ total: 2, completed: 2, failed: 0 });

    const lines: Array<{ id: string; custom_id: string }> = [];
    const iter = await p.batchResults(handle.id);
    for await (const line of iter) {
      lines.push({ id: line.id, custom_id: line.custom_id });
    }
    expect(lines).toEqual([
      { id: "line_1", custom_id: "t1" },
      { id: "line_2", custom_id: "t2" },
    ]);
  });
});
