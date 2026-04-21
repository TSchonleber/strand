import { makeOpenAiProvider } from "@/clients/llm/openai";
import { log } from "@/util/log";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenAI adapter tests. Intercepts api.openai.com with MSW and exercises:
 *  - chat (plain, structured, tool call, reasoning-model param hygiene)
 *  - providerOptions merge
 *  - Batch API round trip (files.create, batches.create, batches.retrieve, files.content)
 *  - unknown tool type (mcp) is dropped silently
 */

const BASE = "https://api.openai.com/v1";

let lastChatBody: Record<string, unknown> | null = null;
let nextChatResponse: Record<string, unknown> | null = null;

function defaultChatResponse(): Record<string, unknown> {
  return {
    id: "chatcmpl_test_001",
    system_fingerprint: "fp_test_openai",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello from openai" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 90 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

// Batch-API fixtures
let batchRecords = new Map<string, Record<string, unknown>>();
let fileContents = new Map<string, string>();

const server = setupServer(
  http.post(`${BASE}/chat/completions`, async ({ request }) => {
    lastChatBody = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(nextChatResponse ?? defaultChatResponse());
  }),
  http.post(`${BASE}/files`, async () => {
    const id = `file_${Math.random().toString(36).slice(2, 10)}`;
    return HttpResponse.json({
      id,
      object: "file",
      bytes: 123,
      created_at: 1_700_000_000,
      filename: "batch.jsonl",
      purpose: "batch",
    });
  }),
  http.post(`${BASE}/batches`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const id = `batch_${Math.random().toString(36).slice(2, 10)}`;
    const record = {
      id,
      object: "batch",
      status: "in_progress",
      input_file_id: body["input_file_id"],
      endpoint: body["endpoint"],
      completion_window: body["completion_window"],
      created_at: 1_700_000_100,
      request_counts: { total: 1, completed: 0, failed: 0 },
    };
    batchRecords.set(id, record);
    return HttpResponse.json(record);
  }),
  http.get(`${BASE}/batches/:id`, ({ params }) => {
    const id = String(params["id"]);
    const record = batchRecords.get(id);
    if (!record) return HttpResponse.json({ error: "not found" }, { status: 404 });
    return HttpResponse.json(record);
  }),
  http.get(`${BASE}/files/:id/content`, ({ params }) => {
    const id = String(params["id"]);
    const body = fileContents.get(id);
    if (body === undefined) return HttpResponse.json({ error: "not found" }, { status: 404 });
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

beforeEach(() => {
  lastChatBody = null;
  nextChatResponse = null;
  batchRecords = new Map();
  fileContents = new Map();
});

afterEach(() => {
  server.resetHandlers(
    http.post(`${BASE}/chat/completions`, async ({ request }) => {
      lastChatBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(nextChatResponse ?? defaultChatResponse());
    }),
    http.post(`${BASE}/files`, async () => {
      const id = `file_${Math.random().toString(36).slice(2, 10)}`;
      return HttpResponse.json({
        id,
        object: "file",
        bytes: 123,
        created_at: 1_700_000_000,
        filename: "batch.jsonl",
        purpose: "batch",
      });
    }),
    http.post(`${BASE}/batches`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const id = `batch_${Math.random().toString(36).slice(2, 10)}`;
      const record = {
        id,
        object: "batch",
        status: "in_progress",
        input_file_id: body["input_file_id"],
        endpoint: body["endpoint"],
        completion_window: body["completion_window"],
        created_at: 1_700_000_100,
        request_counts: { total: 1, completed: 0, failed: 0 },
      };
      batchRecords.set(id, record);
      return HttpResponse.json(record);
    }),
    http.get(`${BASE}/batches/:id`, ({ params }) => {
      const id = String(params["id"]);
      const record = batchRecords.get(id);
      if (!record) return HttpResponse.json({ error: "not found" }, { status: 404 });
      return HttpResponse.json(record);
    }),
    http.get(`${BASE}/files/:id/content`, ({ params }) => {
      const id = String(params["id"]);
      const body = fileContents.get(id);
      if (body === undefined) return HttpResponse.json({ error: "not found" }, { status: 404 });
      return new HttpResponse(body, {
        status: 200,
        headers: { "content-type": "application/jsonl" },
      });
    }),
  );
});

function makeProvider() {
  return makeOpenAiProvider({ apiKey: "sk-test-openai" });
}

describe("openai.chat — plain request", () => {
  it("returns outputText, usage, and responseId", async () => {
    const p = makeProvider();
    const r = await p.chat({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.5,
      maxOutputTokens: 256,
    });

    expect(r.outputText).toBe("hello from openai");
    expect(r.responseId).toBe("chatcmpl_test_001");
    expect(r.systemFingerprint).toBe("fp_test_openai");
    expect(r.usage.inputTokens).toBe(120);
    expect(r.usage.cachedInputTokens).toBe(90);
    expect(r.usage.outputTokens).toBe(30);
    expect(r.usage.reasoningTokens).toBe(0);
    expect(r.usage.costInUsdTicks).toBe(0);
    expect(r.parsed).toBeNull();

    const body = lastChatBody as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-4o-mini");
    expect(body["temperature"]).toBe(0.5);
    expect(body["max_tokens"]).toBe(256);
    expect(body["max_completion_tokens"]).toBeUndefined();
    expect(Array.isArray(body["messages"])).toBe(true);
    const msgs = body["messages"] as Array<Record<string, unknown>>;
    expect(msgs[0]?.["role"]).toBe("system");
    expect(msgs[1]?.["role"]).toBe("user");
  });
});

describe("openai.chat — structured output", () => {
  it("sends json_schema response_format and parses content into parsed", async () => {
    nextChatResponse = {
      id: "chatcmpl_structured",
      system_fingerprint: "fp_s",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify({ ok: true, count: 3 }) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const p = makeProvider();
    const r = await p.chat<{ ok: boolean; count: number }>({
      model: "gpt-4o",
      messages: [{ role: "user", content: "give me json" }],
      structuredOutput: {
        name: "answer",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        strict: true,
      },
    });

    expect(r.parsed).toEqual({ ok: true, count: 3 });

    const body = lastChatBody as Record<string, unknown>;
    const rf = body["response_format"] as Record<string, unknown>;
    expect(rf["type"]).toBe("json_schema");
    const js = rf["json_schema"] as Record<string, unknown>;
    expect(js["name"]).toBe("answer");
    expect(js["strict"]).toBe(true);
  });
});

describe("openai.chat — function tool call", () => {
  it("extracts tool calls with parsed args", async () => {
    nextChatResponse = {
      id: "chatcmpl_tool",
      system_fingerprint: "fp_t",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: JSON.stringify({ city: "Austin", units: "f" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };

    const p = makeProvider();
    const r = await p.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "weather austin" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "gets weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
      toolChoice: "auto",
      parallelToolCalls: false,
    });

    expect(r.outputText).toBe("");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.name).toBe("get_weather");
    expect(r.toolCalls[0]?.args).toEqual({ city: "Austin", units: "f" });

    const body = lastChatBody as Record<string, unknown>;
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["type"]).toBe("function");
    expect(body["tool_choice"]).toBe("auto");
    expect(body["parallel_tool_calls"]).toBe(false);
  });
});

describe("openai.chat — reasoning model (o1-preview)", () => {
  it("strips temperature and uses max_completion_tokens", async () => {
    const p = makeProvider();
    await p.chat({
      model: "o1-preview",
      messages: [{ role: "user", content: "think" }],
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const body = lastChatBody as Record<string, unknown>;
    expect(body["temperature"]).toBeUndefined();
    expect(body["max_tokens"]).toBeUndefined();
    expect(body["max_completion_tokens"]).toBe(2048);
    expect(body["model"]).toBe("o1-preview");
  });
});

describe("openai.chat — providerOptions passthrough", () => {
  it("merges providerOptions fields into request body", async () => {
    const p = makeProvider();
    await p.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      providerOptions: { seed: 42, logit_bias: { "50256": -100 } },
    });

    const body = lastChatBody as Record<string, unknown>;
    expect(body["seed"]).toBe(42);
    expect(body["logit_bias"]).toEqual({ "50256": -100 });
  });
});

describe("openai.chat — unsupported mcp tool dropped silently", () => {
  it("completes successfully and does not send mcp tool to api", async () => {
    const p = makeProvider();
    const r = await p.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "mcp",
          server_label: "brainctl",
          server_url: "https://example.com/mcp",
          allowed_tools: ["memory_search"],
        },
        {
          type: "function",
          function: {
            name: "echo",
            description: "echo",
            parameters: { type: "object" },
          },
        },
      ],
    });

    expect(r.outputText).toBe("hello from openai");
    const body = lastChatBody as Record<string, unknown>;
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["type"]).toBe("function");
  });
});

describe("openai.batch — filesUpload + batchCreate round trip", () => {
  it("uploads JSONL and creates a batch with defaults", async () => {
    const p = makeProvider();
    if (!p.filesUpload || !p.batchCreate || !p.batchGet || !p.batchResults) {
      throw new Error("openai provider missing batch methods");
    }

    const { id: fileId } = await p.filesUpload('{"custom_id":"c1"}\n', "batch");
    expect(fileId).toMatch(/^file_/);

    const handle = await p.batchCreate({ inputFileId: fileId });
    expect(handle.id).toMatch(/^batch_/);
    expect(handle.input_file_id).toBe(fileId);
    expect(handle.endpoint).toBe("/v1/chat/completions");
    expect(handle.completion_window).toBe("24h");
    expect(handle.status).toBe("in_progress");

    const got = await p.batchGet(handle.id);
    expect(got.id).toBe(handle.id);
    expect(got.status).toBe("in_progress");
  });
});

describe("openai.batch — batchResults streams JSONL lines", () => {
  it("iterates parsed result lines from output_file_id content", async () => {
    const p = makeProvider();
    if (!p.filesUpload || !p.batchCreate || !p.batchGet || !p.batchResults) {
      throw new Error("openai provider missing batch methods");
    }

    const { id: fileId } = await p.filesUpload('{"custom_id":"c1"}\n', "batch");
    const handle = await p.batchCreate({ inputFileId: fileId });

    // Simulate completed batch with output file.
    const outputFileId = "file_out_xyz";
    fileContents.set(
      outputFileId,
      [
        JSON.stringify({
          id: "batch_req_1",
          custom_id: "c1",
          response: { status_code: 200, body: { output_text: "hello" } },
        }),
        JSON.stringify({
          id: "batch_req_2",
          custom_id: "c2",
          response: { status_code: 200, body: { output_text: "world" } },
        }),
        "",
      ].join("\n"),
    );
    const rec = batchRecords.get(handle.id);
    if (!rec) throw new Error("batch record missing");
    rec["status"] = "completed";
    rec["output_file_id"] = outputFileId;
    rec["completed_at"] = 1_700_000_200;
    rec["request_counts"] = { total: 2, completed: 2, failed: 0 };

    const iter = await p.batchResults(handle.id);
    const lines = [];
    for await (const line of iter) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.custom_id).toBe("c1");
    expect(lines[1]?.custom_id).toBe("c2");
    expect(lines[0]?.response?.body["output_text"]).toBe("hello");
  });
});

describe("openai.chat — computer_use tool dropped with warn", () => {
  it("drops computer_use silently, logs capability warn, never sends to api", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    const p = makeProvider();
    const r = await p.chat({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "drive desktop" }],
      tools: [
        {
          type: "computer_use",
          display: { width: 1280, height: 800 },
        },
        {
          type: "function",
          function: {
            name: "echo",
            description: "echo",
            parameters: { type: "object" },
          },
        },
      ],
    });

    expect(r.outputText).toBe("hello from openai");
    const body = lastChatBody as Record<string, unknown>;
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["type"]).toBe("function");

    const matched = warnSpy.mock.calls.find(
      ([obj, msg]) =>
        typeof msg === "string" &&
        msg === "llm.computer_use_unsupported" &&
        (obj as { svc?: string; tool?: string }).svc === "openai" &&
        (obj as { svc?: string; tool?: string }).tool === "computer_use",
    );
    expect(matched).toBeDefined();
    warnSpy.mockRestore();
  });
});

describe("openai provider — name + capabilities", () => {
  it("declares expected capabilities", () => {
    const p = makeProvider();
    expect(p.name).toBe("openai");
    expect(p.capabilities.structuredOutput).toBe(true);
    expect(p.capabilities.batch).toBe(true);
    expect(p.capabilities.mcp).toBe(false);
    expect(p.capabilities.promptCacheKey).toBe(false);
    expect(p.capabilities.previousResponseId).toBe(false);
    expect(p.capabilities.serverSideTools).toEqual([]);
  });
});
