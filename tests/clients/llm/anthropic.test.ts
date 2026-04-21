import { buildAnthropicRequest, makeAnthropicProvider } from "@/clients/llm/anthropic";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Anthropic adapter tests. MSW intercepts api.anthropic.com; we assert on the
 * request body and the normalized LlmResult shape.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

let hitCount = 0;
let lastBody: Record<string, unknown> | null = null;
let lastHeaders: Record<string, string> | null = null;
let nextResponse: Record<string, unknown> = {};

function captureHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function defaultResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_test_abc",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250514",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "hello world" }],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
    },
    ...overrides,
  };
}

const server = setupServer(
  http.post(ANTHROPIC_URL, async ({ request }) => {
    hitCount += 1;
    lastHeaders = captureHeaders(request);
    lastBody = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(nextResponse);
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  hitCount = 0;
  lastBody = null;
  lastHeaders = null;
  nextResponse = defaultResponse();
});
afterEach(() => {
  server.resetHandlers(
    http.post(ANTHROPIC_URL, async ({ request }) => {
      hitCount += 1;
      lastHeaders = captureHeaders(request);
      lastBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(nextResponse);
    }),
  );
});

function makeProvider() {
  return makeAnthropicProvider({ apiKey: "test-anthropic-key" });
}

describe("anthropic adapter — chat()", () => {
  it("1. returns simple text response with normalized usage", async () => {
    const p = makeProvider();
    const r = await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(hitCount).toBe(1);
    expect(r.outputText).toBe("hello world");
    expect(r.responseId).toBe("msg_test_abc");
    expect(r.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      reasoningTokens: 0,
      costInUsdTicks: 0,
    });
    expect(r.toolCalls).toEqual([]);
    expect(r.parsed).toBeNull();

    const body = lastBody as Record<string, unknown>;
    expect(body["model"]).toBe("claude-sonnet-4-5-20250514");
    expect(body["max_tokens"]).toBe(4096);
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect(body["system"]).toBeUndefined();
  });

  it("2. lifts system message to top-level `system` field (concatenated)", async () => {
    const p = makeProvider();
    await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [
        { role: "system", content: "persona-block" },
        { role: "system", content: "policies-block" },
        { role: "user", content: "go" },
      ],
    });

    const body = lastBody as Record<string, unknown>;
    expect(body["system"]).toEqual([
      { type: "text", text: "persona-block" },
      { type: "text", text: "policies-block" },
    ]);
    expect(body["messages"]).toEqual([{ role: "user", content: "go" }]);
  });

  it("3. structured output via synthesized emit_<name> tool is parsed from tool_use input", async () => {
    nextResponse = defaultResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "emit_CandidateBatch",
          input: { candidates: [{ kind: "post", text: "yo" }] },
        },
      ],
      stop_reason: "tool_use",
    });

    const p = makeProvider();
    const r = await p.chat<{ candidates: Array<{ kind: string; text: string }> }>({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "produce candidates" }],
      structuredOutput: {
        name: "CandidateBatch",
        schema: {
          type: "object",
          required: ["candidates"],
          properties: { candidates: { type: "array" } },
        },
      },
    });

    expect(r.parsed).toEqual({ candidates: [{ kind: "post", text: "yo" }] });
    const body = lastBody as Record<string, unknown>;
    const tools = body["tools"] as Array<{ name: string; input_schema: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("emit_CandidateBatch");
    expect(body["tool_choice"]).toEqual({ type: "tool", name: "emit_CandidateBatch" });
  });

  it("4. function tool round-trip: tool_use surfaced; tool message becomes user tool_result", async () => {
    nextResponse = defaultResponse({
      content: [
        { type: "text", text: "calling weather" },
        {
          type: "tool_use",
          id: "toolu_42",
          name: "get_weather",
          input: { city: "NYC" },
        },
      ],
      stop_reason: "tool_use",
    });

    const p = makeProvider();
    const r = await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [
        { role: "user", content: "weather in NYC?" },
        { role: "assistant", content: "I'll call a tool." },
        { role: "tool", content: "72F sunny", toolCallId: "toolu_42" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up current weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
      toolChoice: "auto",
    });

    expect(r.toolCalls).toEqual([{ name: "get_weather", args: { city: "NYC" } }]);
    expect(r.outputText).toBe("calling weather");

    const body = lastBody as Record<string, unknown>;
    const tools = body["tools"] as Array<{ name: string; input_schema: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("get_weather");
    expect(body["tool_choice"]).toEqual({ type: "auto" });

    const msgs = body["messages"] as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "user", content: "weather in NYC?" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "I'll call a tool." });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_42", content: "72F sunny" }],
    });
  });

  it("5. promptCacheKey adds cache_control on last system + last user message", async () => {
    const p = makeProvider();
    await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [
        { role: "system", content: "sys-1" },
        { role: "system", content: "sys-2-last" },
        { role: "user", content: "u-1" },
        { role: "assistant", content: "a-1" },
        { role: "user", content: "u-2-last" },
      ],
      promptCacheKey: "strand:reasoner:v1",
    });

    const body = lastBody as Record<string, unknown>;
    const sys = body["system"] as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(sys).toHaveLength(2);
    expect(sys[0]?.cache_control).toBeUndefined();
    expect(sys[1]?.cache_control).toEqual({ type: "ephemeral" });

    const msgs = body["messages"] as Array<{
      role: string;
      content: Array<{ type: string; text: string; cache_control?: { type: string } }> | string;
    }>;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg?.role).toBe("user");
    expect(Array.isArray(lastMsg?.content)).toBe(true);
    const blocks = lastMsg?.content as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });

    // earlier user message not cache-marked
    const firstUser = msgs[0];
    expect(typeof firstUser?.content).toBe("string");
  });

  it("6. MCP tool routed to top-level mcp_servers, not tools", async () => {
    const p = makeProvider();
    await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "use brainctl" }],
      tools: [
        {
          type: "mcp",
          server_label: "brainctl",
          server_url: "https://brain.example.com/mcp",
          authorization: "Bearer secret-token",
          allowed_tools: ["memory_search", "entity_get"],
        },
        {
          type: "function",
          function: {
            name: "ping",
            description: "ping",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const body = lastBody as Record<string, unknown>;
    const mcpServers = body["mcp_servers"] as Array<Record<string, unknown>>;
    expect(mcpServers).toHaveLength(1);
    expect(mcpServers[0]?.["type"]).toBe("url");
    expect(mcpServers[0]?.["url"]).toBe("https://brain.example.com/mcp");
    expect(mcpServers[0]?.["name"]).toBe("brainctl");
    expect(mcpServers[0]?.["authorization_token"]).toBe("secret-token");
    expect(mcpServers[0]?.["tool_configuration"]).toEqual({
      enabled: true,
      allowed_tools: ["memory_search", "entity_get"],
    });

    const tools = body["tools"] as Array<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("ping");
  });

  it("7. server-side web_search translated to web_search_20250305", async () => {
    const p = makeProvider();
    await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "search the web" }],
      tools: [{ type: "web_search" }],
    });

    const body = lastBody as Record<string, unknown>;
    const tools = body["tools"] as Array<{ type: string; name?: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("web_search_20250305");
    expect(tools[0]?.name).toBe("web_search");
  });

  it("8. capabilities declare batch=true (inline-batch path) and previousResponseId=false", () => {
    const p = makeProvider();
    expect(p.name).toBe("anthropic");
    expect(p.capabilities.structuredOutput).toBe(true);
    expect(p.capabilities.mcp).toBe(true);
    expect(p.capabilities.serverSideTools).toEqual(["web_search"]);
    expect(p.capabilities.batch).toBe(true);
    expect(p.capabilities.promptCacheKey).toBe(true);
    expect(p.capabilities.previousResponseId).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(200_000);
    // File-based batch path NOT exposed — inline-only adapter.
    expect(p.filesUpload).toBeUndefined();
    expect(p.batchCreate).toBeUndefined();
    // Inline path exposed.
    expect(typeof p.batchCreateInline).toBe("function");
    expect(typeof p.batchGet).toBe("function");
    expect(typeof p.batchResults).toBe("function");
    expect(typeof p.buildBatchLine).toBe("function");
  });

  it("9. parallelToolCalls=false → disable_parallel_tool_use=true", () => {
    const req = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "x" }],
      parallelToolCalls: false,
    });
    expect(req.disable_parallel_tool_use).toBe(true);

    const req2 = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "x" }],
      parallelToolCalls: true,
    });
    expect(req2.disable_parallel_tool_use).toBeUndefined();
  });

  it("10. providerOptions override fields (thinking, top_k, etc.)", () => {
    const req = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "x" }],
      providerOptions: {
        thinking: { type: "enabled", budget_tokens: 10000 },
        top_k: 40,
      },
    });
    expect(req["thinking"]).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(req["top_k"]).toBe(40);
  });

  it("11. temperature and maxOutputTokens pass through", () => {
    const req = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "x" }],
      temperature: 0.7,
      maxOutputTokens: 2048,
    });
    expect(req.temperature).toBe(0.7);
    expect(req.max_tokens).toBe(2048);
  });

  it("12. include / previousResponseId / store / maxTurns silently dropped", () => {
    const req = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "x" }],
      include: ["mcp_call_output"],
      previousResponseId: "resp_123",
      store: true,
      maxTurns: 5,
    });
    expect(req["include"]).toBeUndefined();
    expect(req["previous_response_id"]).toBeUndefined();
    expect(req["store"]).toBeUndefined();
    expect(req["max_turns"]).toBeUndefined();
  });

  it("13. computer_use (default enabledTools) emits all 3 native dated tools", () => {
    const req = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "drive the desktop" }],
      tools: [
        {
          type: "computer_use",
          display: { width: 1280, height: 800 },
        },
      ],
    });

    const tools = req.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(3);
    expect(tools[0]).toEqual({
      type: "computer_20250124",
      name: "computer",
      display_width_px: 1280,
      display_height_px: 800,
      display_number: 1,
    });
    expect(tools[1]).toEqual({ type: "bash_20250124", name: "bash" });
    expect(tools[2]).toEqual({ type: "text_editor_20250124", name: "str_replace_editor" });
  });

  it("14. computer_use enabledTools: ['computer'] → only computer_20250124 emitted", () => {
    const req = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "screenshot please" }],
      tools: [
        {
          type: "computer_use",
          display: { width: 1024, height: 768, displayNumber: 2 },
          enabledTools: ["computer"],
        },
      ],
    });

    const tools = req.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: "computer_20250124",
      name: "computer",
      display_width_px: 1024,
      display_height_px: 768,
      display_number: 2,
    });
  });

  it("15. computer_use coexists with function + MCP tools, all three routed correctly", () => {
    const req = buildAnthropicRequest({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "combo" }],
      tools: [
        {
          type: "function",
          function: {
            name: "ping",
            description: "ping",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "computer_use",
          display: { width: 800, height: 600 },
          enabledTools: ["computer", "bash"],
        },
        {
          type: "mcp",
          server_label: "brainctl",
          server_url: "https://brain.example.com/mcp",
          authorization: "Bearer secret",
          allowed_tools: ["memory_search"],
        },
      ],
    });

    const tools = req.tools as Array<Record<string, unknown>>;
    // function tool + computer + bash (enabledTools excludes text_editor)
    expect(tools).toHaveLength(3);
    expect(tools[0]?.["name"]).toBe("ping");
    expect(tools[1]?.["type"]).toBe("computer_20250124");
    expect(tools[2]?.["type"]).toBe("bash_20250124");

    const mcp = req.mcp_servers as Array<Record<string, unknown>>;
    expect(mcp).toHaveLength(1);
    expect(mcp[0]?.["name"]).toBe("brainctl");
  });

  it("17. batchCreateInline: sends {requests: [{custom_id, params}]} to /v1/messages/batches", async () => {
    let batchCreateBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://api.anthropic.com/v1/messages/batches", async ({ request }) => {
        batchCreateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "msgbatch_abc",
          type: "message_batch",
          processing_status: "in_progress",
          created_at: "2026-04-20T12:00:00Z",
          ended_at: null,
          expires_at: "2026-04-21T12:00:00Z",
          archived_at: null,
          cancel_initiated_at: null,
          results_url: null,
          request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        });
      }),
    );

    const p = makeProvider();
    if (typeof p.batchCreateInline !== "function") throw new Error("no batchCreateInline");

    const handle = await p.batchCreateInline({
      requests: [
        {
          custom_id: "consolidator:dream_cycle",
          body: {
            model: "claude-sonnet-4-5-20250514",
            max_tokens: 1024,
            messages: [{ role: "user", content: "dream" }],
          },
        },
        {
          custom_id: "consolidator:gaps_scan",
          body: {
            model: "claude-sonnet-4-5-20250514",
            max_tokens: 1024,
            messages: [{ role: "user", content: "gaps" }],
          },
        },
      ],
    });

    expect(handle.id).toBe("msgbatch_abc");
    expect(handle.status).toBe("in_progress");
    expect(handle.request_counts).toEqual({ total: 2, completed: 0, failed: 0 });
    expect(handle.created_at).toBeGreaterThan(0);
    expect(handle.completed_at).toBeUndefined();

    const body = batchCreateBody as unknown as Record<string, unknown>;
    const requests = body["requests"] as Array<{
      custom_id: string;
      params: Record<string, unknown>;
    }>;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.custom_id).toBe("consolidator:dream_cycle");
    expect(requests[0]?.params?.["model"]).toBe("claude-sonnet-4-5-20250514");
    expect(requests[0]?.params?.["messages"]).toEqual([{ role: "user", content: "dream" }]);
    expect(requests[1]?.custom_id).toBe("consolidator:gaps_scan");
  });

  it("18. batchGet: maps processing_status in_progress→in_progress, canceling→cancelling, ended→completed", async () => {
    let next: "in_progress" | "canceling" | "ended" = "in_progress";
    server.use(
      http.get("https://api.anthropic.com/v1/messages/batches/:id", () => {
        return HttpResponse.json({
          id: "msgbatch_xyz",
          type: "message_batch",
          processing_status: next,
          created_at: "2026-04-20T12:00:00Z",
          ended_at: next === "ended" ? "2026-04-20T12:30:00Z" : null,
          expires_at: "2026-04-21T12:00:00Z",
          archived_at: null,
          cancel_initiated_at: next === "canceling" ? "2026-04-20T12:15:00Z" : null,
          results_url:
            next === "ended"
              ? "https://api.anthropic.com/v1/messages/batches/msgbatch_xyz/results"
              : null,
          request_counts:
            next === "ended"
              ? { processing: 0, succeeded: 3, errored: 1, canceled: 0, expired: 1 }
              : { processing: 5, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        });
      }),
    );

    const p = makeProvider();
    if (typeof p.batchGet !== "function") throw new Error("no batchGet");

    next = "in_progress";
    const h1 = await p.batchGet("msgbatch_xyz");
    expect(h1.status).toBe("in_progress");
    expect(h1.completed_at).toBeUndefined();

    next = "canceling";
    const h2 = await p.batchGet("msgbatch_xyz");
    expect(h2.status).toBe("cancelling");

    next = "ended";
    const h3 = await p.batchGet("msgbatch_xyz");
    expect(h3.status).toBe("completed");
    expect(h3.completed_at).toBeGreaterThan(0);
    expect(h3.request_counts).toEqual({ total: 5, completed: 3, failed: 2 });
  });

  it("19. batchResults: succeeded→response.body, errored/canceled/expired→error", async () => {
    const jsonl = [
      JSON.stringify({
        custom_id: "consolidator:dream_cycle",
        result: {
          type: "succeeded",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "dream output" }],
          },
        },
      }),
      JSON.stringify({
        custom_id: "consolidator:gaps_scan",
        result: {
          type: "errored",
          error: { type: "overloaded_error", message: "server overloaded" },
        },
      }),
      JSON.stringify({
        custom_id: "consolidator:retirement_analysis",
        result: { type: "expired" },
      }),
      JSON.stringify({
        custom_id: "consolidator:reflexion_write",
        result: { type: "canceled" },
      }),
    ].join("\n");

    server.use(
      http.get("https://api.anthropic.com/v1/messages/batches/:id", ({ params }) => {
        return HttpResponse.json({
          id: String(params["id"]),
          type: "message_batch",
          processing_status: "ended",
          created_at: "2026-04-20T12:00:00Z",
          ended_at: "2026-04-20T12:30:00Z",
          expires_at: "2026-04-21T12:00:00Z",
          archived_at: null,
          cancel_initiated_at: null,
          results_url: `https://api.anthropic.com/v1/messages/batches/${params["id"]}/results`,
          request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 1, expired: 1 },
        });
      }),
      http.get("https://api.anthropic.com/v1/messages/batches/:id/results", () => {
        return new HttpResponse(`${jsonl}\n`, {
          status: 200,
          headers: { "content-type": "application/x-jsonl" },
        });
      }),
    );

    const p = makeProvider();
    if (typeof p.batchResults !== "function") throw new Error("no batchResults");

    const iter = await p.batchResults("msgbatch_results");
    const lines: Array<{
      id: string;
      custom_id: string;
      response?: { status_code: number; body: Record<string, unknown> };
      error?: { code: string; message: string };
    }> = [];
    for await (const line of iter) {
      lines.push(line);
    }
    expect(lines).toHaveLength(4);

    const ok = lines.find((l) => l.custom_id === "consolidator:dream_cycle");
    expect(ok?.response?.status_code).toBe(200);
    const okBody = ok?.response?.body as Record<string, unknown>;
    expect(okBody?.["id"]).toBe("msg_1");
    const content = okBody?.["content"] as Array<{ type: string; text: string }>;
    expect(content?.[0]?.text).toBe("dream output");

    const errored = lines.find((l) => l.custom_id === "consolidator:gaps_scan");
    expect(errored?.response).toBeUndefined();
    expect(errored?.error?.code).toBe("overloaded_error");
    expect(errored?.error?.message).toBe("server overloaded");

    const expired = lines.find((l) => l.custom_id === "consolidator:retirement_analysis");
    expect(expired?.error?.code).toBe("expired");

    const canceled = lines.find((l) => l.custom_id === "consolidator:reflexion_write");
    expect(canceled?.error?.code).toBe("canceled");
  });

  it("20. buildBatchLine: returns Anthropic-shaped body with method/url envelope", () => {
    const p = makeProvider();
    if (typeof p.buildBatchLine !== "function") throw new Error("no buildBatchLine");

    const line = p.buildBatchLine(
      {
        model: "claude-sonnet-4-5-20250514",
        messages: [
          { role: "system", content: "persona" },
          { role: "user", content: "hi" },
        ],
        maxOutputTokens: 2048,
      },
      "consolidator:dream_cycle",
    );

    expect(line.custom_id).toBe("consolidator:dream_cycle");
    expect(line.method).toBe("POST");
    expect(line.url).toBe("/v1/messages");
    expect(line.body["model"]).toBe("claude-sonnet-4-5-20250514");
    expect(line.body["max_tokens"]).toBe(2048);
    expect(line.body["system"]).toEqual([{ type: "text", text: "persona" }]);
    expect(line.body["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("16. anthropic-beta: computer-use-2025-01-24 header set when computer_use requested; absent otherwise", async () => {
    const p = makeProvider();
    await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "screenshot" }],
      tools: [{ type: "computer_use", display: { width: 1280, height: 800 } }],
    });
    expect(lastHeaders?.["anthropic-beta"]).toBe("computer-use-2025-01-24");

    // Negative case: plain call should not set the beta header.
    await p.chat({
      model: "claude-sonnet-4-5-20250514",
      messages: [{ role: "user", content: "plain" }],
    });
    expect(lastHeaders?.["anthropic-beta"]).toBeUndefined();
  });
});
