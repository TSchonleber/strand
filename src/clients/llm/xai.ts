import {
  type GrokBatch,
  type GrokCallInput,
  type GrokCallOutput,
  type GrokInclude,
  type GrokTool,
  grokBatchCreate,
  grokBatchGet,
  grokBatchResults,
  grokCall,
  grokFilesUpload,
} from "@/clients/grok";
import { log } from "@/util/log";
import type { LlmProvider } from "./provider";
import type {
  LlmBatchCreateArgs,
  LlmBatchHandle,
  LlmBatchResultLine,
  LlmCall,
  LlmCapabilities,
  LlmMessage,
  LlmResult,
} from "./types";

/**
 * xAI adapter. Thin wrapper over the existing `grokCall` + batch helpers in
 * `src/clients/grok.ts`. We do NOT reimplement the wire format — this file
 * only translates between `LlmCall` / `LlmResult` and the legacy
 * `GrokCallInput` / `GrokCallOutput` shapes.
 *
 * Known v1 limitations (documented here, caller beware):
 *  - `LlmCall.messages` → `GrokCallInput.systemPrompts` + `userInput` is a
 *    lossy translation. The existing grok client does not model multi-turn
 *    user/assistant/tool history; we concatenate non-system messages into a
 *    single user input with `[role]` prefixes. When the factory migration
 *    rewrites loops off `grokCall` directly, lift that restriction by
 *    extending the base client to accept a full message array.
 *  - `LlmCall.providerOptions` is dropped with a warn — no escape hatch in
 *    `GrokCallInput` yet. Extend `GrokCallInput` first if a caller needs it.
 */

export const XAI_CAPABILITIES: LlmCapabilities = {
  structuredOutput: true,
  mcp: true,
  serverSideTools: ["x_search", "web_search", "code_interpreter"],
  batch: true,
  promptCacheKey: true,
  previousResponseId: true,
  functionToolLoop: true,
  computerUse: false,
  maxContextTokens: 2_000_000,
};

const XAI_INCLUDE_VALUES: readonly GrokInclude[] = [
  "mcp_call_output",
  "reasoning.encrypted_content",
  "web_search_call.action.sources",
  "x_search_call.action.sources",
  "inline_citations",
];

function splitMessages(messages: LlmMessage[]): {
  systemPrompts: string[];
  userInput: string;
} {
  const systemPrompts: string[] = [];
  const nonSystem: LlmMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemPrompts.push(m.content);
    } else {
      nonSystem.push(m);
    }
  }

  // Fast path: exactly one user message → pass content through verbatim.
  if (nonSystem.length === 1 && nonSystem[0]?.role === "user") {
    return { systemPrompts, userInput: nonSystem[0].content };
  }

  // Multi-turn fallback: collapse with role prefixes. v1 limitation.
  const parts: string[] = [];
  for (const m of nonSystem) {
    const prefix = m.role === "user" ? "[user]" : m.role === "assistant" ? "[assistant]" : "[tool]";
    parts.push(`${prefix} ${m.content}`);
  }
  return { systemPrompts, userInput: parts.join("\n\n") };
}

function filterIncludes(include: string[] | undefined): GrokInclude[] | undefined {
  if (!include || include.length === 0) return undefined;
  const out: GrokInclude[] = [];
  for (const v of include) {
    if ((XAI_INCLUDE_VALUES as readonly string[]).includes(v)) {
      out.push(v as GrokInclude);
    }
  }
  return out.length > 0 ? out : undefined;
}

function translateCall(input: LlmCall): GrokCallInput {
  const { systemPrompts, userInput } = splitMessages(input.messages);

  if (input.providerOptions && Object.keys(input.providerOptions).length > 0) {
    log.warn(
      { svc: "xai", keys: Object.keys(input.providerOptions) },
      "xai.adapter.providerOptions_dropped",
    );
  }

  const call: GrokCallInput = {
    model: input.model,
    systemPrompts,
    userInput,
  };

  if (input.tools && input.tools.length > 0) {
    const filtered: GrokTool[] = [];
    for (const t of input.tools) {
      if (t.type === "computer_use") {
        log.warn({ svc: "xai", tool: "computer_use" }, "llm.computer_use_unsupported");
        continue;
      }
      filtered.push(t as GrokTool);
    }
    if (filtered.length > 0) call.tools = filtered;
  }
  if (input.toolChoice !== undefined) call.toolChoice = input.toolChoice;
  if (input.parallelToolCalls !== undefined) call.parallelToolCalls = input.parallelToolCalls;
  if (input.maxTurns !== undefined) call.maxTurns = input.maxTurns;
  if (input.temperature !== undefined) call.temperature = input.temperature;
  if (input.maxOutputTokens !== undefined) call.maxOutputTokens = input.maxOutputTokens;
  if (input.promptCacheKey) call.promptCacheKey = input.promptCacheKey;
  const includes = filterIncludes(input.include);
  if (includes) call.include = includes;
  if (input.previousResponseId) call.previousResponseId = input.previousResponseId;
  if (input.store !== undefined) call.store = input.store;

  if (input.structuredOutput) {
    call.responseSchema = {
      name: input.structuredOutput.name,
      schema: input.structuredOutput.schema,
      ...(input.structuredOutput.strict !== undefined
        ? { strict: input.structuredOutput.strict }
        : {}),
    };
  }

  return call;
}

function translateResult<T>(out: GrokCallOutput<T>): LlmResult<T> {
  return {
    outputText: out.outputText,
    parsed: out.parsed,
    responseId: out.responseId,
    systemFingerprint: out.systemFingerprint,
    usage: out.usage,
    toolCalls: out.toolCalls,
    rawResponse: out.rawResponse,
  };
}

function translateBatch(batch: GrokBatch): LlmBatchHandle {
  const handle: LlmBatchHandle = {
    id: batch.id,
    // `finalizing` is not in the LlmBatchStatus union; surface as `in_progress`.
    status: batch.status === "finalizing" ? "in_progress" : batch.status,
    input_file_id: batch.input_file_id,
    created_at: batch.created_at,
  };
  if (batch.output_file_id !== undefined) handle.output_file_id = batch.output_file_id;
  if (batch.error_file_id !== undefined) handle.error_file_id = batch.error_file_id;
  if (batch.completed_at !== undefined) handle.completed_at = batch.completed_at;
  if (batch.request_counts !== undefined) handle.request_counts = batch.request_counts;
  if (batch.endpoint !== undefined) handle.endpoint = batch.endpoint;
  if (batch.completion_window !== undefined) handle.completion_window = batch.completion_window;
  return handle;
}

/**
 * Build an xAI-backed LlmProvider. `opts` is accepted for interface symmetry
 * with the other adapters (OpenAI, Anthropic, Gemini); the underlying
 * `grokCall` is pre-configured via env — opts is logged at construction and
 * otherwise unused in v1. Extend the base client to honor per-provider creds
 * when multi-tenant support lands.
 */
export function makeXaiProvider(opts: { apiKey: string; baseURL?: string }): LlmProvider {
  // Surface the mismatch without blowing up. Keeps the signature honest so
  // the factory call site compiles; avoids silently ignoring a caller-passed
  // key that looks like it does something.
  if (opts.apiKey || opts.baseURL) {
    log.debug(
      {
        svc: "xai",
        base_url_override: Boolean(opts.baseURL),
      },
      "xai.adapter.make.v1_uses_env_creds",
    );
  }

  return {
    name: "xai",
    capabilities: XAI_CAPABILITIES,

    async chat<T = unknown>(input: LlmCall): Promise<LlmResult<T>> {
      const call = translateCall(input);
      const out = await grokCall<T>(call);
      return translateResult(out);
    },

    async filesUpload(jsonl: string, purpose?: string): Promise<{ id: string }> {
      return grokFilesUpload(jsonl, (purpose as "batch" | undefined) ?? "batch");
    },

    async batchCreate(args: LlmBatchCreateArgs): Promise<LlmBatchHandle> {
      const createArgs: Parameters<typeof grokBatchCreate>[0] = {
        inputFileId: args.inputFileId,
      };
      if (args.endpoint === "/v1/responses" || args.endpoint === "/v1/chat/completions") {
        createArgs.endpoint = args.endpoint;
      }
      if (args.completionWindow === "24h") {
        createArgs.completionWindow = args.completionWindow;
      }
      if (args.metadata !== undefined) createArgs.metadata = args.metadata;
      const batch = await grokBatchCreate(createArgs);
      return translateBatch(batch);
    },

    async batchGet(id: string): Promise<LlmBatchHandle> {
      const batch = await grokBatchGet(id);
      return translateBatch(batch);
    },

    async batchResults(id: string): Promise<AsyncIterable<LlmBatchResultLine>> {
      const iter = await grokBatchResults(id);
      return mapAsyncIterable(iter, (line) => {
        const out: LlmBatchResultLine = {
          id: line.id,
          custom_id: line.custom_id,
        };
        if (line.response !== undefined) out.response = line.response;
        if (line.error !== undefined) out.error = line.error;
        return out;
      });
    },
  };
}

function mapAsyncIterable<A, B>(src: AsyncIterable<A>, fn: (a: A) => B): AsyncIterable<B> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for await (const v of src) yield fn(v);
    },
  };
}
