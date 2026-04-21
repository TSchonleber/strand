import { log } from "@/util/log";
import OpenAI, { toFile } from "openai";
import type { LlmProvider } from "./provider";
import type {
  LlmBatchCreateArgs,
  LlmBatchHandle,
  LlmBatchResultLine,
  LlmCall,
  LlmCapabilities,
  LlmMessage,
  LlmResult,
  LlmTool,
  LlmToolCall,
  LlmToolChoice,
} from "./types";

/**
 * OpenAI-compatible adapter (Chat Completions API).
 *
 * One adapter, many endpoints: by taking `baseURL`, this also covers Groq,
 * Together, Ollama, LM Studio, vLLM, etc. Chat Completions is the universal
 * OpenAI-compat surface — every compat provider supports it, Responses API
 * is not universal. xAI lives in its own adapter (uses Responses features).
 *
 * Reasoning models (o1*, o3*): strip `temperature`, prefer `max_completion_tokens`.
 * MCP + server-side tools: dropped (not available on Chat Completions); warn logged.
 * `promptCacheKey`: OpenAI caches automatically, no explicit key — debug log, ignore.
 * `include` / `previousResponseId` / `store`: Responses-only; silently dropped.
 * `providerOptions`: merged last — escape hatch for provider-specific knobs.
 */

const CAPABILITIES: LlmCapabilities = {
  structuredOutput: true,
  mcp: false,
  serverSideTools: [] as readonly string[],
  batch: true,
  promptCacheKey: false,
  previousResponseId: false,
  functionToolLoop: true,
  computerUse: false,
  maxContextTokens: 128000,
};

function isReasoningModel(model: string): boolean {
  return model.startsWith("o1") || model.startsWith("o3");
}

function mapMessages(messages: readonly LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name !== undefined) base["name"] = m.name;
    if (m.role === "tool" && m.toolCallId !== undefined) base["tool_call_id"] = m.toolCallId;
    return base;
  });
}

function mapToolChoice(tc: LlmToolChoice): unknown {
  // Chat Completions shape matches our shape 1:1 for the union variants.
  return tc;
}

function splitTools(tools: readonly LlmTool[] | undefined): {
  functions: Array<Record<string, unknown>>;
  droppedKinds: string[];
} {
  const functions: Array<Record<string, unknown>> = [];
  const droppedKinds: string[] = [];
  if (!tools) return { functions, droppedKinds };
  for (const t of tools) {
    if (t.type === "function") {
      const ft = t as Extract<LlmTool, { type: "function" }>;
      const fn: Record<string, unknown> = {
        name: ft.function.name,
        description: ft.function.description,
        parameters: ft.function.parameters,
      };
      if (ft.function.strict !== undefined) fn["strict"] = ft.function.strict;
      functions.push({ type: "function", function: fn });
    } else {
      droppedKinds.push(t.type);
    }
  }
  return { functions, droppedKinds };
}

function buildRequest(input: LlmCall): Record<string, unknown> {
  const reasoning = isReasoningModel(input.model);
  const req: Record<string, unknown> = {
    model: input.model,
    messages: mapMessages(input.messages),
  };

  if (!reasoning && input.temperature !== undefined) {
    req["temperature"] = input.temperature;
  }

  if (input.maxOutputTokens !== undefined) {
    if (reasoning) {
      req["max_completion_tokens"] = input.maxOutputTokens;
    } else {
      req["max_tokens"] = input.maxOutputTokens;
    }
  }

  const { functions, droppedKinds } = splitTools(input.tools);
  if (droppedKinds.length > 0) {
    log.warn(
      { svc: "openai", model: input.model, dropped: droppedKinds },
      "openai.tools.unsupported_dropped",
    );
  }
  if (functions.length > 0) req["tools"] = functions;

  if (input.toolChoice !== undefined) req["tool_choice"] = mapToolChoice(input.toolChoice);
  if (input.parallelToolCalls !== undefined) req["parallel_tool_calls"] = input.parallelToolCalls;

  if (input.structuredOutput) {
    req["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: input.structuredOutput.name,
        schema: input.structuredOutput.schema,
        strict: input.structuredOutput.strict ?? true,
      },
    };
  }

  if (input.promptCacheKey !== undefined) {
    log.debug(
      { svc: "openai", model: input.model },
      "openai.prompt_cache_key.ignored_auto_caching",
    );
  }
  // include / previousResponseId / store: Responses-only, silently dropped.

  if (input.providerOptions) {
    for (const [k, v] of Object.entries(input.providerOptions)) {
      req[k] = v;
    }
  }

  return req;
}

function extractToolCalls(message: Record<string, unknown> | undefined): LlmToolCall[] {
  if (!message) return [];
  const raw = message["tool_calls"];
  if (!Array.isArray(raw)) return [];
  const out: LlmToolCall[] = [];
  for (const tc of raw) {
    if (typeof tc !== "object" || tc === null) continue;
    const rec = tc as Record<string, unknown>;
    const fn = rec["function"] as Record<string, unknown> | undefined;
    if (!fn) continue;
    const name = String(fn["name"] ?? "unknown");
    const argsRaw = fn["arguments"];
    let args: unknown = argsRaw;
    if (typeof argsRaw === "string") {
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = argsRaw;
      }
    }
    out.push({ name, args });
  }
  return out;
}

export function makeOpenAiProvider(opts: {
  apiKey: string;
  baseURL?: string;
}): LlmProvider {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? "https://api.openai.com/v1",
  });

  const chat = async <T = unknown>(input: LlmCall): Promise<LlmResult<T>> => {
    const req = buildRequest(input);
    const t0 = Date.now();

    // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
    const resp = (await (client.chat.completions as any).create(req)) as Record<string, unknown>;

    const responseId = String(resp["id"] ?? "");
    const systemFingerprint = (resp["system_fingerprint"] as string | undefined) ?? null;
    const choices = (resp["choices"] as Array<Record<string, unknown>> | undefined) ?? [];
    const firstChoice = choices[0];
    const message = firstChoice
      ? ((firstChoice["message"] as Record<string, unknown> | undefined) ?? {})
      : {};
    const contentRaw = message["content"];
    const outputText = typeof contentRaw === "string" ? contentRaw : "";

    const usageRaw = (resp["usage"] as Record<string, unknown>) ?? {};
    const inputDetails =
      (usageRaw["prompt_tokens_details"] as Record<string, number> | undefined) ?? {};
    const outputDetails =
      (usageRaw["completion_tokens_details"] as Record<string, number> | undefined) ?? {};

    const usage = {
      inputTokens: Number(usageRaw["prompt_tokens"] ?? 0),
      cachedInputTokens: Number(inputDetails["cached_tokens"] ?? 0),
      outputTokens: Number(usageRaw["completion_tokens"] ?? 0),
      reasoningTokens: Number(outputDetails["reasoning_tokens"] ?? 0),
      costInUsdTicks: 0,
    };

    const toolCalls = extractToolCalls(message);

    log.info(
      {
        svc: "openai",
        model: input.model,
        response_id: responseId,
        system_fingerprint: systemFingerprint,
        durationMs: Date.now() - t0,
        usage,
        tool_calls: toolCalls.length,
      },
      "openai.call",
    );

    let parsed: T | null = null;
    if (input.structuredOutput && outputText) {
      try {
        parsed = JSON.parse(outputText) as T;
      } catch (e) {
        log.warn({ svc: "openai", err: e }, "openai.parse_failed");
      }
    }

    return {
      outputText,
      parsed,
      responseId,
      systemFingerprint,
      usage,
      toolCalls,
      rawResponse: resp,
    };
  };

  const filesUpload = async (jsonl: string, purpose = "batch"): Promise<{ id: string }> => {
    const file = await toFile(Buffer.from(jsonl, "utf8"), "batch.jsonl", {
      type: "application/jsonl",
    });
    // biome-ignore lint/suspicious/noExplicitAny: SDK boundary — purpose values vary
    const resp = await (client.files as any).create({ file, purpose });
    const id = String((resp as { id?: string }).id ?? "");
    log.info({ svc: "openai", file_id: id, purpose }, "openai.files.upload");
    return { id };
  };

  const batchCreate = async (args: LlmBatchCreateArgs): Promise<LlmBatchHandle> => {
    const body: Record<string, unknown> = {
      input_file_id: args.inputFileId,
      endpoint: args.endpoint ?? "/v1/chat/completions",
      completion_window: args.completionWindow ?? "24h",
    };
    if (args.metadata) body["metadata"] = args.metadata;

    // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
    const resp = (await (client.batches as any).create(body)) as Record<string, unknown>;
    const handle = normalizeBatchHandle(resp);
    log.info(
      {
        svc: "openai",
        batch_id: handle.id,
        status: handle.status,
        endpoint: handle.endpoint,
        input_file_id: handle.input_file_id,
      },
      "openai.batch.create",
    );
    return handle;
  };

  const batchGet = async (id: string): Promise<LlmBatchHandle> => {
    // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
    const resp = (await (client.batches as any).retrieve(id)) as Record<string, unknown>;
    const handle = normalizeBatchHandle(resp);
    log.debug(
      {
        svc: "openai",
        batch_id: handle.id,
        status: handle.status,
        request_counts: handle.request_counts,
      },
      "openai.batch.get",
    );
    return handle;
  };

  const batchResults = async (id: string): Promise<AsyncIterable<LlmBatchResultLine>> => {
    const handle = await batchGet(id);
    const failed = handle.request_counts?.failed ?? 0;
    if (failed > 0) {
      log.warn(
        { svc: "openai", batch_id: id, request_counts: handle.request_counts },
        "openai.batch.partial_failures",
      );
    }
    if (!handle.output_file_id) {
      throw new Error(
        `openai batchResults: batch ${id} has no output_file_id (status=${handle.status})`,
      );
    }
    // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
    const fileResp = await (client.files as any).content(handle.output_file_id);
    let text: string;
    if (typeof fileResp === "string") {
      text = fileResp;
    } else if (
      fileResp &&
      typeof (fileResp as { text?: () => Promise<string> }).text === "function"
    ) {
      text = await (fileResp as { text: () => Promise<string> }).text();
    } else {
      text = String(fileResp);
    }
    return toAsyncIterable(parseJsonlLines(text));
  };

  return {
    name: "openai",
    capabilities: CAPABILITIES,
    chat,
    filesUpload,
    batchCreate,
    batchGet,
    batchResults,
  };
}

function normalizeBatchHandle(resp: Record<string, unknown>): LlmBatchHandle {
  const handle: LlmBatchHandle = {
    id: String(resp["id"] ?? ""),
    status: (resp["status"] as LlmBatchHandle["status"]) ?? "validating",
    input_file_id: String(resp["input_file_id"] ?? ""),
    created_at: Number(resp["created_at"] ?? 0),
  };
  const outputFileId = resp["output_file_id"];
  if (typeof outputFileId === "string") handle.output_file_id = outputFileId;
  const errorFileId = resp["error_file_id"];
  if (typeof errorFileId === "string") handle.error_file_id = errorFileId;
  const completedAt = resp["completed_at"];
  if (typeof completedAt === "number") handle.completed_at = completedAt;
  const counts = resp["request_counts"];
  if (counts && typeof counts === "object") {
    const c = counts as Record<string, number>;
    handle.request_counts = {
      total: Number(c["total"] ?? 0),
      completed: Number(c["completed"] ?? 0),
      failed: Number(c["failed"] ?? 0),
    };
  }
  const endpoint = resp["endpoint"];
  if (typeof endpoint === "string") handle.endpoint = endpoint;
  const window = resp["completion_window"];
  if (typeof window === "string") handle.completion_window = window;
  return handle;
}

function toAsyncIterable<T>(src: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const v of src) yield v;
    },
  };
}

function* parseJsonlLines(text: string): Iterable<LlmBatchResultLine> {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line) as LlmBatchResultLine;
    } catch (err) {
      log.warn({ svc: "openai", err, line: line.slice(0, 200) }, "openai.batch.parse_line_failed");
    }
  }
}
