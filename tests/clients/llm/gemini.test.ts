import type { LlmCall } from "@/clients/llm/types";
import { log } from "@/util/log";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * We mock `@google/genai` directly because the SDK drives its own fetch
 * plumbing that MSW can't reliably intercept through the package's Node
 * bundle. This gives us a deterministic observation point on exactly what
 * the adapter sends into `client.models.generateContent(...)`.
 */

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: generateContentMock },
  })),
}));

// Import AFTER vi.mock so the adapter picks up the mocked constructor.
import { makeGeminiProvider } from "@/clients/llm/gemini";

function textResp(text: string, extra: Record<string, unknown> = {}) {
  return {
    text,
    responseId: "resp_test_1",
    modelVersion: "gemini-2.0-pro",
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: {
      promptTokenCount: 120,
      cachedContentTokenCount: 40,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 10,
    },
    functionCalls: undefined,
    ...extra,
  };
}

function baseCall(overrides: Partial<LlmCall> = {}): LlmCall {
  return {
    model: "gemini-2.0-pro",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("gemini adapter", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it("returns a simple text response", async () => {
    generateContentMock.mockResolvedValueOnce(textResp("hi there"));
    const provider = makeGeminiProvider({ apiKey: "k" });

    const out = await provider.chat(baseCall());

    expect(out.outputText).toBe("hi there");
    expect(out.responseId).toBe("resp_test_1");
    expect(out.systemFingerprint).toBe("gemini-2.0-pro");
    expect(out.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 10,
      costInUsdTicks: 0,
    });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const req = generateContentMock.mock.calls[0]?.[0];
    expect(req.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(req.config.systemInstruction).toBeUndefined();
  });

  it("lifts system messages into config.systemInstruction and maps assistant→model", async () => {
    generateContentMock.mockResolvedValueOnce(textResp("ok"));
    const provider = makeGeminiProvider({ apiKey: "k" });

    await provider.chat(
      baseCall({
        messages: [
          { role: "system", content: "be terse" },
          { role: "system", content: "no emojis" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "again" },
        ],
      }),
    );

    const req = generateContentMock.mock.calls[0]?.[0];
    expect(req.config.systemInstruction).toBe("be terse\n\nno emojis");
    expect(req.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "again" }] },
    ]);
  });

  it("wires structured output via responseMimeType + responseSchema and parses JSON", async () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    };
    generateContentMock.mockResolvedValueOnce(textResp('{"n":7}'));
    const provider = makeGeminiProvider({ apiKey: "k" });

    const out = await provider.chat<{ n: number }>(
      baseCall({ structuredOutput: { name: "Shape", schema } }),
    );

    const req = generateContentMock.mock.calls[0]?.[0];
    expect(req.config.responseMimeType).toBe("application/json");
    expect(req.config.responseSchema).toBe(schema);
    expect(out.parsed).toEqual({ n: 7 });
  });

  it("nests function tools under functionDeclarations and extracts function calls", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: "",
      responseId: "r2",
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "get_weather", args: { city: "Paris" } },
              },
            ],
          },
        },
      ],
      // No `functionCalls` helper here — exercises the fallback path.
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      },
    });
    const provider = makeGeminiProvider({ apiKey: "k" });

    const out = await provider.chat(
      baseCall({
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "look up weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
      }),
    );

    const req = generateContentMock.mock.calls[0]?.[0];
    expect(req.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "look up weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    ]);
    expect(out.toolCalls).toEqual([{ name: "get_weather", args: { city: "Paris" } }]);
  });

  it("translates toolChoice auto→AUTO and required→ANY", async () => {
    const provider = makeGeminiProvider({ apiKey: "k" });

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "f",
          description: "d",
          parameters: { type: "object" },
        },
      },
    ];

    generateContentMock.mockResolvedValueOnce(textResp(""));
    await provider.chat(baseCall({ tools, toolChoice: "auto" }));
    let req = generateContentMock.mock.calls[0]?.[0];
    expect(req.config.toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });

    generateContentMock.mockResolvedValueOnce(textResp(""));
    await provider.chat(baseCall({ tools, toolChoice: "required" }));
    req = generateContentMock.mock.calls[1]?.[0];
    expect(req.config.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });

    generateContentMock.mockResolvedValueOnce(textResp(""));
    await provider.chat(
      baseCall({
        tools,
        toolChoice: { type: "function", function: { name: "f" } },
      }),
    );
    req = generateContentMock.mock.calls[2]?.[0];
    expect(req.config.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] },
    });
  });

  it("drops mcp tools silently and does not forward them", async () => {
    generateContentMock.mockResolvedValueOnce(textResp("ok"));
    const provider = makeGeminiProvider({ apiKey: "k" });
    expect(provider.capabilities.mcp).toBe(false);

    await provider.chat(
      baseCall({
        tools: [
          {
            type: "mcp",
            server_label: "brainctl",
            server_url: "https://brain.example/mcp",
            allowed_tools: ["memory_search"],
          },
        ],
      }),
    );

    const req = generateContentMock.mock.calls[0]?.[0];
    // Either no tools array at all, or an empty one — never an mcp entry.
    const toolsField = req.config.tools as unknown[] | undefined;
    if (toolsField) {
      for (const t of toolsField) {
        expect(JSON.stringify(t)).not.toContain("mcp");
        expect(JSON.stringify(t)).not.toContain("brainctl");
      }
    } else {
      expect(toolsField).toBeUndefined();
    }
  });

  it("translates server-side google_search and code_execution tools", async () => {
    generateContentMock.mockResolvedValueOnce(textResp("ok"));
    const provider = makeGeminiProvider({ apiKey: "k" });

    await provider.chat(
      baseCall({
        tools: [{ type: "google_search" }, { type: "code_execution" }],
      }),
    );

    const req = generateContentMock.mock.calls[0]?.[0];
    expect(req.config.tools).toEqual([{ googleSearch: {} }, { codeExecution: {} }]);
  });

  it("declares capabilities conservatively for Gemini", () => {
    const provider = makeGeminiProvider({ apiKey: "k" });
    expect(provider.name).toBe("gemini");
    expect(provider.capabilities).toEqual({
      structuredOutput: true,
      mcp: false,
      serverSideTools: ["google_search", "code_execution"],
      batch: false,
      promptCacheKey: false,
      previousResponseId: false,
      functionToolLoop: true,
      computerUse: false,
      maxContextTokens: 2_000_000,
    });
  });

  it("drops computer_use tool silently with capability warn; never forwarded to SDK", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    generateContentMock.mockResolvedValueOnce(textResp("ok"));
    const provider = makeGeminiProvider({ apiKey: "k" });

    await provider.chat(
      baseCall({
        tools: [
          { type: "computer_use", display: { width: 1280, height: 800 } },
          { type: "google_search" },
        ],
      }),
    );

    const req = generateContentMock.mock.calls[0]?.[0];
    const toolsField = req.config.tools as unknown[] | undefined;
    expect(toolsField).toEqual([{ googleSearch: {} }]);

    const matched = warnSpy.mock.calls.find(
      ([obj, msg]) =>
        typeof msg === "string" &&
        msg === "llm.computer_use_unsupported" &&
        (obj as { svc?: string; tool?: string }).svc === "gemini" &&
        (obj as { svc?: string; tool?: string }).tool === "computer_use",
    );
    expect(matched).toBeDefined();
    warnSpy.mockRestore();
  });

  it("does not expose batch methods", () => {
    const provider = makeGeminiProvider({ apiKey: "k" });
    expect(provider.filesUpload).toBeUndefined();
    expect(provider.batchCreate).toBeUndefined();
    expect(provider.batchGet).toBeUndefined();
    expect(provider.batchResults).toBeUndefined();
  });
});
