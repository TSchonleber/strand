import { log } from "@/util/log";
import { GoogleGenAI } from "@google/genai";
import type { LlmProvider } from "./provider";
import type {
  LlmCall,
  LlmCapabilities,
  LlmMcpTool,
  LlmMessage,
  LlmResult,
  LlmServerTool,
  LlmTool,
  LlmToolCall,
  LlmToolChoice,
  LlmUsage,
} from "./types";

/**
 * Gemini adapter (Google Gen AI SDK, `@google/genai`).
 *
 * Ground truth, 2026-04-20:
 *  - SDK: `new GoogleGenAI({ apiKey })` → `client.models.generateContent(...)`.
 *  - Roles: user / model (assistant is "model" here, not "assistant").
 *  - System messages are lifted to `config.systemInstruction`, NOT sent as
 *    content entries. Multiple system messages are concatenated with "\n\n".
 *  - Tools split: function declarations are nested under
 *    `config.tools = [{ functionDeclarations: [...] }]`. Server-side tools
 *    (googleSearch, codeExecution) are sibling top-level tool entries.
 *  - Tool choice → `config.toolConfig.functionCallingConfig.mode` with
 *    auto→AUTO, required→ANY, none→NONE. `{type:"function", function:{name}}`
 *    translates to mode=ANY + allowedFunctionNames=[name].
 *  - Structured output: responseMimeType=application/json + responseSchema.
 *    Gemini accepts a SUBSET of JSON Schema — drops $ref, allOf,
 *    additionalProperties, some formats. We pass the schema through
 *    unchanged; sanitization is caller's problem (documented in
 *    capabilities.structuredOutput=true-with-caveats).
 *  - MCP is not supported on the Gemini API client surface for remote tools
 *    in the way xAI / OpenAI Responses accept. Caller-supplied `type:"mcp"`
 *    tools are dropped with a warn.
 *  - Prompt caching: uses explicit `cachedContent` (a separately-created
 *    CachedContent resource). The `promptCacheKey` knob isn't translatable
 *    in v1 — we drop it and declare `capabilities.promptCacheKey=false`.
 *  - Batch API: Vertex-only; not implemented → `capabilities.batch=false`.
 *  - `previous_response_id` equivalent: none → `capabilities.previousResponseId=false`.
 *  - Usage:
 *      inputTokens         ← promptTokenCount
 *      cachedInputTokens   ← cachedContentTokenCount ?? 0
 *      outputTokens        ← candidatesTokenCount
 *      reasoningTokens     ← thoughtsTokenCount ?? 0  (thinking-budget models)
 *      costInUsdTicks      ← 0 (Gemini API doesn't return a cost meter)
 */

const CAPABILITIES: LlmCapabilities = {
  structuredOutput: true,
  mcp: false,
  serverSideTools: ["google_search", "code_execution"],
  batch: false,
  promptCacheKey: false,
  previousResponseId: false,
  maxContextTokens: 2_000_000,
};

export interface GeminiProviderOptions {
  apiKey: string;
  /** Custom endpoint (testing / proxy). Maps to SDK httpOptions.baseUrl. */
  baseURL?: string;
}

export function makeGeminiProvider(opts: GeminiProviderOptions): LlmProvider {
  const client = new GoogleGenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { httpOptions: { baseUrl: opts.baseURL } } : {}),
  });

  async function chat<T = unknown>(input: LlmCall): Promise<LlmResult<T>> {
    const { systemInstruction, contents } = splitMessages(input.messages);
    const { functionTools, serverTools, mcpDropped } = partitionTools(input.tools ?? []);

    if (mcpDropped > 0) {
      log.warn({ svc: "gemini", dropped: mcpDropped }, "gemini.mcp_unsupported_dropped");
    }
    if (input.promptCacheKey) {
      log.debug({ svc: "gemini" }, "gemini.prompt_cache_key_unsupported");
    }
    if (input.previousResponseId) {
      log.debug({ svc: "gemini" }, "gemini.previous_response_id_unsupported");
    }

    // biome-ignore lint/suspicious/noExplicitAny: SDK typing for `tools` is a broad union; we build it structurally
    const sdkTools: any[] = [];
    if (functionTools.length > 0) {
      sdkTools.push({ functionDeclarations: functionTools });
    }
    for (const st of serverTools) {
      sdkTools.push(st);
    }

    // biome-ignore lint/suspicious/noExplicitAny: GenerateContentConfig shape assembled incrementally
    const config: Record<string, any> = {};
    if (systemInstruction !== null) config["systemInstruction"] = systemInstruction;
    if (input.temperature !== undefined) config["temperature"] = input.temperature;
    if (input.maxOutputTokens !== undefined) config["maxOutputTokens"] = input.maxOutputTokens;
    if (sdkTools.length > 0) config["tools"] = sdkTools;

    const toolConfig = translateToolChoice(input.toolChoice, functionTools);
    if (toolConfig) config["toolConfig"] = toolConfig;

    if (input.structuredOutput) {
      config["responseMimeType"] = "application/json";
      config["responseSchema"] = input.structuredOutput.schema;
    }

    const providerOpts = (input.providerOptions ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(providerOpts)) {
      // Opaque passthrough for Gemini-specific knobs (thinkingConfig,
      // safetySettings, cachedContent, etc.). Caller owns correctness.
      config[k] = v;
    }

    const t0 = Date.now();
    // biome-ignore lint/suspicious/noExplicitAny: SDK surface is wide; we only use documented fields
    const resp: any = await client.models.generateContent({
      model: input.model,
      contents,
      config,
    });

    const outputText: string =
      typeof resp?.text === "string"
        ? resp.text
        : (extractTextFromCandidates(resp?.candidates) ?? "");

    const toolCalls: LlmToolCall[] = extractFunctionCalls(resp);
    const usage = extractUsage(resp?.usageMetadata);
    const responseId: string = String(resp?.responseId ?? "");
    const systemFingerprint: string | null =
      typeof resp?.modelVersion === "string" ? resp.modelVersion : null;

    let parsed: T | null = null;
    if (input.structuredOutput && outputText) {
      try {
        parsed = JSON.parse(outputText) as T;
      } catch (e) {
        log.warn({ svc: "gemini", err: e }, "gemini.parse_failed");
      }
    }

    log.info(
      {
        svc: "gemini",
        model: input.model,
        response_id: responseId,
        model_version: systemFingerprint,
        durationMs: Date.now() - t0,
        usage,
        tool_calls: toolCalls.length,
      },
      "gemini.call",
    );

    return {
      outputText,
      parsed,
      responseId,
      systemFingerprint,
      usage,
      toolCalls,
      rawResponse: resp,
    };
  }

  return {
    name: "gemini",
    capabilities: CAPABILITIES,
    chat,
  };
}

// ─── helpers ────────────────────────────────────────────────────

function splitMessages(messages: LlmMessage[]): {
  systemInstruction: string | null;
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
} {
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      // Gemini expects tool results as FunctionResponse parts; the v1 adapter
      // doesn't drive multi-turn tool loops via LlmCall messages — loops pass
      // the tool's output as a follow-up user message. Represent it here as
      // a user turn with the text so the model has the context.
      contents.push({ role: "user", parts: [{ text: m.content }] });
      continue;
    }
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: m.content }] });
  }

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : null,
    contents,
  };
}

interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function partitionTools(tools: LlmTool[]): {
  functionTools: FunctionDeclaration[];
  serverTools: Array<Record<string, unknown>>;
  mcpDropped: number;
} {
  const functionTools: FunctionDeclaration[] = [];
  const serverTools: Array<Record<string, unknown>> = [];
  let mcpDropped = 0;

  for (const t of tools) {
    if (isMcpTool(t)) {
      mcpDropped += 1;
      continue;
    }
    if (isFunctionTool(t)) {
      functionTools.push({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      });
      continue;
    }
    // Server-side tool. Translate the two Gemini-native ones; drop unknowns.
    const st = t as LlmServerTool;
    if (st.type === "google_search") {
      serverTools.push({ googleSearch: {} });
    } else if (st.type === "code_execution") {
      serverTools.push({ codeExecution: {} });
    } else {
      log.warn({ svc: "gemini", tool_type: st.type }, "gemini.unknown_server_tool_dropped");
    }
  }

  return { functionTools, serverTools, mcpDropped };
}

function isMcpTool(t: LlmTool): t is LlmMcpTool {
  return (t as { type?: string }).type === "mcp";
}

function isFunctionTool(t: LlmTool): t is Extract<LlmTool, { type: "function" }> {
  return (t as { type?: string }).type === "function";
}

function translateToolChoice(
  choice: LlmToolChoice | undefined,
  functionTools: FunctionDeclaration[],
): Record<string, unknown> | null {
  if (choice === undefined) return null;
  if (functionTools.length === 0) return null;

  if (typeof choice === "string") {
    const mode = choice === "auto" ? "AUTO" : choice === "required" ? "ANY" : "NONE";
    return { functionCallingConfig: { mode } };
  }
  // Specific function pin → ANY + allowlist of one.
  if (choice.type === "function") {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [choice.function.name],
      },
    };
  }
  return null;
}

function extractTextFromCandidates(candidates: unknown): string | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> } };
  const parts = first?.content?.parts ?? [];
  const texts: string[] = [];
  for (const p of parts) {
    if (typeof p?.text === "string") texts.push(p.text);
  }
  return texts.length > 0 ? texts.join("") : null;
}

function extractFunctionCalls(resp: unknown): LlmToolCall[] {
  const out: LlmToolCall[] = [];
  // Prefer SDK helper `.functionCalls`.
  const helper = (resp as { functionCalls?: Array<{ name?: string; args?: unknown }> })
    ?.functionCalls;
  if (Array.isArray(helper)) {
    for (const fc of helper) {
      out.push({ name: String(fc?.name ?? "unknown"), args: fc?.args ?? null });
    }
    return out;
  }
  // Fallback: walk candidates[0].content.parts for functionCall parts.
  const candidates = (resp as { candidates?: unknown[] })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return out;
  const first = candidates[0] as {
    content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> };
  };
  const parts = first?.content?.parts ?? [];
  for (const p of parts) {
    const fc = p?.functionCall;
    if (fc && typeof fc.name === "string") {
      out.push({ name: fc.name, args: fc.args ?? null });
    }
  }
  return out;
}

function extractUsage(meta: unknown): LlmUsage {
  const m = (meta ?? {}) as {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  return {
    inputTokens: m.promptTokenCount ?? 0,
    cachedInputTokens: m.cachedContentTokenCount ?? 0,
    outputTokens: m.candidatesTokenCount ?? 0,
    reasoningTokens: m.thoughtsTokenCount ?? 0,
    costInUsdTicks: 0,
  };
}
