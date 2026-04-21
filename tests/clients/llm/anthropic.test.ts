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
let nextResponse: Record<string, unknown> = {};

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
  nextResponse = defaultResponse();
});
afterEach(() => {
  server.resetHandlers(
    http.post(ANTHROPIC_URL, async ({ request }) => {
      hitCount += 1;
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

  it("8. capabilities declare batch=false and previousResponseId=false", () => {
    const p = makeProvider();
    expect(p.name).toBe("anthropic");
    expect(p.capabilities.structuredOutput).toBe(true);
    expect(p.capabilities.mcp).toBe(true);
    expect(p.capabilities.serverSideTools).toEqual(["web_search"]);
    expect(p.capabilities.batch).toBe(false);
    expect(p.capabilities.promptCacheKey).toBe(true);
    expect(p.capabilities.previousResponseId).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(200_000);
    // Batch optional methods absent (so hasBatch() returns false cleanly).
    expect(p.filesUpload).toBeUndefined();
    expect(p.batchCreate).toBeUndefined();
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
});
