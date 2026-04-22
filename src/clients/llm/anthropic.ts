import { log } from "@/util/log";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "./provider";
import type {
  LlmBatchCreateInlineArgs,
  LlmBatchHandle,
  LlmBatchRequestLine,
  LlmBatchResultLine,
  LlmBatchStatus,
  LlmCall,
  LlmCapabilities,
  LlmComputerUseTool,
  LlmFunctionTool,
  LlmMcpTool,
  LlmResult,
  LlmServerTool,
  LlmTool,
  LlmToolCall,
  LlmUsage,
} from "./types";

/**
 * Anthropic Messages API adapter. Implements the provider-agnostic LlmProvider
 * surface defined in `./provider.ts`.
 *
 * Mapping rules enforced here (ground-truthed against claude.com/claude-code
 * + docs.anthropic.com, 2026-04-20):
 *
 *  - system messages → top-level `system` field (concatenated; NOT in messages)
 *  - user/assistant messages → `messages` array; tool results become user
 *    messages with `tool_result` content blocks
 *  - structured output → synthesized single-use tool `emit_<name>` with
 *    tool_choice forcing that tool; we parse the tool input as the parsed
 *    result (this is the Anthropic-sanctioned pattern)
 *  - function tools → `tools` array
 *  - MCP tools (type=mcp) → top-level `mcp_servers`, NOT `tools`
 *  - server-side `web_search` type → translated to `web_search_20250305`
 *  - `promptCacheKey` present → attach `cache_control: {type:"ephemeral"}`
 *    to the last system message and the last user/assistant message
 *    (two-breakpoint pattern that maximizes cache hit rate)
 *  - `parallelToolCalls` → inverted into `disable_parallel_tool_use`
 *  - `temperature` is always allowed (Claude reasoning uses `thinking`, not
 *    temperature-stripping rules; callers who want thinking pass it via
 *    `providerOptions.thinking`)
 *  - `max_tokens` is REQUIRED by the Messages API — default 4096 if missing
 *  - `include`, `previousResponseId`, `store` → silently dropped (unsupported)
 *  - `providerOptions` merged last so callers can override any field
 *
 * Batch: implemented via the inline-batch path. Anthropic's Message Batches
 * endpoint accepts requests inline (no separate file upload) as
 * `{requests: [{custom_id, params}]}`. We expose `batchCreateInline`,
 * `batchGet`, and `batchResults`, plus `buildBatchLine` for callers that want
 * a uniform JSONL-style representation (the method/url envelope is discarded
 * by `batchCreateInline` since Anthropic inline batches don't use one).
 */

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

const CAPABILITIES: LlmCapabilities = {
  structuredOutput: true,
  mcp: true,
  serverSideTools: ["web_search"],
  batch: true,
  promptCacheKey: true,
  previousResponseId: false,
  functionToolLoop: true,
  computerUse: true,
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
};

// Opts for makeAnthropicProvider.
export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
}

// Anthropic Messages API shapes we care about — typed loosely at the SDK
// boundary because SDK types lag new features (mcp_servers, server_tools,
// cache_control fields added late). We keep strict types on our interface
// boundary and loosen only at the SDK call site.
type AnthropicContentBlock =
  | { type: "text"; text: string; [k: string]: unknown }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicToolInput {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: AnthropicSystemBlock[];
  tools?: (AnthropicToolInput | Record<string, unknown>)[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
  temperature?: number;
  mcp_servers?: Array<Record<string, unknown>>;
  disable_parallel_tool_use?: boolean;
  [k: string]: unknown;
}

const COMPUTER_USE_BETA_HEADER = "computer-use-2025-01-24";

/** Whether any tool in the call will emit Anthropic computer-use native declarations. */
export function hasComputerUseTool(input: LlmCall): boolean {
  for (const t of input.tools ?? []) {
    if (isComputerUseTool(t)) return true;
  }
  return false;
}

/** Build the Anthropic request body from the provider-agnostic LlmCall. */
export function buildAnthropicRequest(input: LlmCall): AnthropicRequestBody {
  const systemTexts: string[] = [];
  const convo: AnthropicMessage[] = [];

  for (const m of input.messages) {
    if (m.role === "system") {
      systemTexts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      // Tool results are surfaced as user-role messages with tool_result blocks.
      convo.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === "user" || m.role === "assistant") {
      convo.push({ role: m.role, content: m.content });
    }
  }

  const body: AnthropicRequestBody = {
    model: input.model,
    max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: convo,
  };

  if (systemTexts.length > 0) {
    body.system = systemTexts.map((t) => ({ type: "text", text: t }));
  }

  if (input.temperature !== undefined) {
    body.temperature = input.temperature;
  }

  // Split incoming tools: function tools → tools[], MCP tools → mcp_servers[],
  // computer-use tools → tools[] with native 20250124 dated declarations,
  // server tools → tools[] with provider-native type translation.
  const functionTools: AnthropicToolInput[] = [];
  const serverTools: Record<string, unknown>[] = [];
  const mcpServers: Record<string, unknown>[] = [];
  const computerUseTools: Record<string, unknown>[] = [];

  for (const t of input.tools ?? []) {
    if (isFunctionTool(t)) {
      functionTools.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      });
    } else if (isComputerUseTool(t)) {
      for (const decl of buildComputerUseToolDeclarations(t)) {
        computerUseTools.push(decl);
      }
    } else if (isMcpTool(t)) {
      const server: Record<string, unknown> = {
        type: "url",
        url: t.server_url,
        name: t.server_label,
      };
      if (t.authorization !== undefined) {
        server["authorization_token"] = t.authorization.replace(/^Bearer\s+/i, "");
      }
      if (t.allowed_tools && t.allowed_tools.length > 0) {
        server["tool_configuration"] = {
          enabled: true,
          allowed_tools: t.allowed_tools,
        };
      }
      mcpServers.push(server);
    } else if (isServerTool(t)) {
      if (t.type === "web_search") {
        // Translate the generic `web_search` shape to Anthropic's dated tool.
        serverTools.push({
          type: "web_search_20250305",
          name: "web_search",
          ...stripType(t),
        });
      } else {
        // Pass unknown server-tool types through verbatim — Anthropic rejects
        // unsupported tool types, which surfaces as a clear 400 from the API.
        serverTools.push({ ...t });
      }
    }
  }

  // Synthesize the emit_<name> tool for structured output. Force the model to
  // call it via tool_choice; the tool's input is the parsed object.
  if (input.structuredOutput) {
    const emitName = `emit_${input.structuredOutput.name}`;
    functionTools.push({
      name: emitName,
      description: `Emit the final ${input.structuredOutput.name} payload as this tool's input. Call this tool exactly once with the structured result.`,
      input_schema: input.structuredOutput.schema,
    });
    body.tool_choice = { type: "tool", name: emitName };
  } else if (input.toolChoice !== undefined) {
    const tc = translateToolChoice(input.toolChoice);
    if (tc) body.tool_choice = tc;
  }

  if (functionTools.length > 0 || serverTools.length > 0 || computerUseTools.length > 0) {
    body.tools = [...functionTools, ...computerUseTools, ...serverTools];
  }
  if (mcpServers.length > 0) {
    body.mcp_servers = mcpServers;
  }

  if (input.parallelToolCalls === false) {
    body.disable_parallel_tool_use = true;
  }

  // promptCacheKey → ephemeral cache breakpoints on last system + last
  // user/assistant message. The cache key itself is not a field on
  // Anthropic's API; cache hits are routed by content hash + breakpoint
  // placement. We use the presence of the key as a signal to mark
  // breakpoints; the key value itself is attached to metadata.user_id so
  // callers can still bucket cost/metrics by tenant.
  if (input.promptCacheKey) {
    if (body.system && body.system.length > 0) {
      const last = body.system[body.system.length - 1];
      if (last) {
        last.cache_control = { type: "ephemeral" };
      }
    }
    const lastMsg = body.messages[body.messages.length - 1];
    if (lastMsg) {
      if (typeof lastMsg.content === "string") {
        lastMsg.content = [
          {
            type: "text",
            text: lastMsg.content,
            cache_control: { type: "ephemeral" },
          },
        ];
      } else {
        const lastBlock = lastMsg.content[lastMsg.content.length - 1];
        if (lastBlock) {
          lastBlock["cache_control"] = { type: "ephemeral" };
        }
      }
    }
    body["metadata"] = { user_id: `prompt_cache:${input.promptCacheKey}` };
  }

  // providerOptions wins over everything else so callers can inject
  // thinking, top_k, stop_sequences, etc.
  if (input.providerOptions) {
    for (const [k, v] of Object.entries(input.providerOptions)) {
      body[k] = v;
    }
  }

  // include / previousResponseId / store / maxTurns — Anthropic's Messages
  // API doesn't support any of these. Drop silently per the contract.
  void input.include;
  void input.previousResponseId;
  void input.store;
  void input.maxTurns;

  return body;
}

function isFunctionTool(t: LlmTool): t is LlmFunctionTool {
  return (t as { type?: string }).type === "function";
}
function isMcpTool(t: LlmTool): t is LlmMcpTool {
  return (t as { type?: string }).type === "mcp";
}
function isComputerUseTool(t: LlmTool): t is LlmComputerUseTool {
  return (t as { type?: string }).type === "computer_use";
}
function isServerTool(t: LlmTool): t is LlmServerTool {
  return (
    typeof (t as { type?: unknown }).type === "string" &&
    !isFunctionTool(t) &&
    !isMcpTool(t) &&
    !isComputerUseTool(t)
  );
}

/**
 * Translate a single `computer_use` LlmTool into one or more Anthropic dated
 * native-tool declarations. Defaults to all three (computer + bash +
 * text_editor) when `enabledTools` is omitted.
 */
function buildComputerUseToolDeclarations(t: LlmComputerUseTool): Record<string, unknown>[] {
  const enabled = t.enabledTools ?? ["computer", "bash", "text_editor"];
  const out: Record<string, unknown>[] = [];
  for (const kind of enabled) {
    if (kind === "computer") {
      out.push({
        type: "computer_20250124",
        name: "computer",
        display_width_px: t.display.width,
        display_height_px: t.display.height,
        display_number: t.display.displayNumber ?? 1,
      });
    } else if (kind === "bash") {
      out.push({ type: "bash_20250124", name: "bash" });
    } else if (kind === "text_editor") {
      out.push({ type: "text_editor_20250124", name: "str_replace_editor" });
    }
  }
  return out;
}
function stripType<T extends { type: string }>(t: T): Omit<T, "type"> {
  const { type: _discard, ...rest } = t;
  void _discard;
  return rest;
}

function translateToolChoice(
  choice: NonNullable<LlmCall["toolChoice"]>,
): AnthropicRequestBody["tool_choice"] {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return { type: "auto" };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage;
}

/** Pick text blocks, join with no separator (Anthropic emits one block per run). */
function extractOutputText(content: AnthropicContentBlock[] | undefined): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}

function extractToolCalls(content: AnthropicContentBlock[] | undefined): LlmToolCall[] {
  if (!content) return [];
  const out: LlmToolCall[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      out.push({
        name: String((block as { name?: unknown }).name ?? "unknown"),
        args: (block as { input?: unknown }).input ?? null,
      });
    }
  }
  return out;
}

function mapUsage(u: AnthropicUsage | undefined): LlmUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    cachedInputTokens: u?.cache_read_input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    reasoningTokens: 0,
    costInUsdTicks: 0,
  };
}

export function makeAnthropicProvider(opts: AnthropicProviderOptions): LlmProvider {
  const clientOptions: { apiKey: string; baseURL?: string } = { apiKey: opts.apiKey };
  if (opts.baseURL !== undefined) clientOptions.baseURL = opts.baseURL;
  const client = new Anthropic(clientOptions);

  async function chat<T = unknown>(input: LlmCall): Promise<LlmResult<T>> {
    const req = buildAnthropicRequest(input);
    const t0 = Date.now();

    // Opt into computer-use beta per-call when the caller asked for it. The
    // SDK accepts headers as part of RequestOptions (second arg); we keep the
    // header conditional so non-computer-use calls aren't tagged with a beta
    // opt-in they don't need.
    const options = hasComputerUseTool(input)
      ? { headers: { "anthropic-beta": COMPUTER_USE_BETA_HEADER } }
      : undefined;

    // SDK types lag — our boundary types are already strict, so cast here.
    const resp = (await (client.messages.create as (r: unknown, o?: unknown) => Promise<unknown>)(
      req,
      options,
    )) as AnthropicResponse;

    const responseId = String(resp.id ?? "");
    const content = resp.content;
    const outputText = extractOutputText(content);
    const toolCalls = extractToolCalls(content);
    const usage = mapUsage(resp.usage);

    let parsed: T | null = null;
    if (input.structuredOutput) {
      const emitName = `emit_${input.structuredOutput.name}`;
      const emitCall = toolCalls.find((c) => c.name === emitName);
      if (emitCall) {
        parsed = emitCall.args as T;
      }
    }

    const cacheRatio = usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : 0;
    log.info(
      {
        svc: "anthropic",
        model: input.model,
        response_id: responseId,
        durationMs: Date.now() - t0,
        usage,
        cache_ratio: Math.round(cacheRatio * 100) / 100,
        prompt_cache_key: input.promptCacheKey ?? null,
        tool_calls: toolCalls.length,
      },
      "anthropic.call",
    );

    return {
      outputText,
      parsed,
      responseId,
      systemFingerprint: null,
      usage,
      toolCalls,
      rawResponse: resp,
    };
  }

  async function batchCreateInline(args: LlmBatchCreateInlineArgs): Promise<LlmBatchHandle> {
    // Anthropic's SDK expects `{requests: [{custom_id, params}]}`. Our
    // cross-provider shape is `{custom_id, body}` — rename `body` to `params`
    // and hand off. Completion window / metadata are not honored by the inline
    // endpoint today; we log them at debug if set so callers aren't silently
    // surprised.
    if (args.completionWindow !== undefined || args.metadata !== undefined) {
      log.debug(
        {
          svc: "anthropic",
          has_completion_window: args.completionWindow !== undefined,
          has_metadata: args.metadata !== undefined,
        },
        "anthropic.batch.create_inline.unsupported_opts_dropped",
      );
    }

    const requests = args.requests.map((r) => ({ custom_id: r.custom_id, params: r.body }));
    const t0 = Date.now();
    const resp = (await (client.messages.batches.create as (b: unknown) => Promise<unknown>)({
      requests,
    })) as AnthropicMessageBatch;

    log.info(
      {
        svc: "anthropic",
        batch_id: resp.id,
        request_count: args.requests.length,
        processing_status: resp.processing_status,
        durationMs: Date.now() - t0,
      },
      "anthropic.batch.create_inline",
    );
    return translateBatch(resp);
  }

  async function batchGet(id: string): Promise<LlmBatchHandle> {
    const resp = (await (client.messages.batches.retrieve as (id: string) => Promise<unknown>)(
      id,
    )) as AnthropicMessageBatch;
    return translateBatch(resp);
  }

  async function batchResults(id: string): Promise<AsyncIterable<LlmBatchResultLine>> {
    const iter = (await (client.messages.batches.results as (id: string) => Promise<unknown>)(
      id,
    )) as AsyncIterable<AnthropicMessageBatchIndividualResponse>;
    return mapInlineResults(iter);
  }

  function buildBatchLineImpl(call: LlmCall, customId: string): LlmBatchRequestLine {
    // Keep the interface uniform: return a method/url-wrapped line so file-
    // based callers can JSONL.stringify it. batchCreateInline strips the
    // envelope when it posts — the url is advisory for Anthropic.
    return {
      custom_id: customId,
      method: "POST",
      url: "/v1/messages",
      body: buildAnthropicRequest(call) as unknown as Record<string, unknown>,
    };
  }

  return {
    name: "anthropic",
    capabilities: CAPABILITIES,
    chat,
    batchCreateInline,
    batchGet,
    batchResults,
    buildBatchLine: buildBatchLineImpl,
  } satisfies LlmProvider;
}

export const _capabilities: LlmCapabilities = CAPABILITIES;

// ─── Batch: inline path ─────────────────────────────────────────────────────

interface AnthropicMessageBatchRequestCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

interface AnthropicMessageBatch {
  id: string;
  type?: "message_batch";
  processing_status: "in_progress" | "canceling" | "ended";
  created_at: string;
  ended_at: string | null;
  expires_at: string;
  archived_at: string | null;
  cancel_initiated_at: string | null;
  request_counts: AnthropicMessageBatchRequestCounts;
  results_url: string | null;
}

interface AnthropicMessageBatchIndividualResponse {
  custom_id: string;
  result:
    | { type: "succeeded"; message: Record<string, unknown> }
    | { type: "errored"; error: { type?: string; message?: string; [k: string]: unknown } }
    | { type: "canceled" }
    | { type: "expired" };
}

function mapBatchStatus(s: AnthropicMessageBatch["processing_status"]): LlmBatchStatus {
  switch (s) {
    case "in_progress":
      return "in_progress";
    case "canceling":
      return "cancelling";
    case "ended":
      // Anthropic's `ended` means "processing stopped" regardless of per-request
      // outcome — succeeded, errored, expired, canceled all roll up into it.
      // Per-request failures surface through the results stream, not here.
      return "completed";
  }
}

function rfc3339ToUnixSeconds(s: string | null): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function translateBatch(b: AnthropicMessageBatch): LlmBatchHandle {
  const counts = b.request_counts;
  const total =
    counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired;
  const handle: LlmBatchHandle = {
    id: b.id,
    status: mapBatchStatus(b.processing_status),
    created_at: rfc3339ToUnixSeconds(b.created_at),
    request_counts: {
      total,
      completed: counts.succeeded,
      failed: counts.errored + counts.expired + counts.canceled,
    },
  };
  if (b.ended_at) handle.completed_at = rfc3339ToUnixSeconds(b.ended_at);
  return handle;
}

async function* mapInlineResults(
  iter: AsyncIterable<AnthropicMessageBatchIndividualResponse>,
): AsyncIterable<LlmBatchResultLine> {
  for await (const line of iter) {
    const out: LlmBatchResultLine = {
      id: line.custom_id,
      custom_id: line.custom_id,
    };
    const r = line.result;
    if (r.type === "succeeded") {
      out.response = {
        status_code: 200,
        body: r.message,
      };
    } else if (r.type === "errored") {
      const err = r.error ?? {};
      out.error = {
        code: String(err["type"] ?? "errored"),
        message: String(err["message"] ?? "request errored"),
      };
    } else if (r.type === "canceled") {
      out.error = { code: "canceled", message: "request canceled" };
    } else if (r.type === "expired") {
      out.error = { code: "expired", message: "request expired" };
    }
    yield out;
  }
}
