import { log } from "@/util/log";
import Anthropic from "@anthropic-ai/sdk";
import { LlmCapabilityError, type LlmProvider } from "./provider";
import type {
  LlmCall,
  LlmCapabilities,
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
 * Batch: not implemented in v1. Anthropic's Message Batches endpoint accepts
 * requests inline (no separate file upload), so it doesn't fit the current
 * `filesUpload + batchCreate(input_file_id)` interface without interface
 * changes. See Phase 1.5+ inline-batch path.
 * TODO(phase-1.5-inline-batch): add inline-batch support via a
 * provider-inline request shape once the LlmProvider interface gains it.
 */

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

const CAPABILITIES: LlmCapabilities = {
  structuredOutput: true,
  mcp: true,
  serverSideTools: ["web_search"],
  batch: false,
  promptCacheKey: true,
  previousResponseId: false,
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
  // server tools → tools[] with provider-native type translation.
  const functionTools: AnthropicToolInput[] = [];
  const serverTools: Record<string, unknown>[] = [];
  const mcpServers: Record<string, unknown>[] = [];

  for (const t of input.tools ?? []) {
    if (isFunctionTool(t)) {
      functionTools.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      });
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

  if (functionTools.length > 0 || serverTools.length > 0) {
    body.tools = [...functionTools, ...serverTools];
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
function isServerTool(t: LlmTool): t is LlmServerTool {
  return typeof (t as { type?: unknown }).type === "string" && !isFunctionTool(t) && !isMcpTool(t);
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

    // SDK types lag — our boundary types are already strict, so cast here.
    const resp = (await (client.messages.create as (r: unknown) => Promise<unknown>)(
      req,
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

    log.info(
      {
        svc: "anthropic",
        model: input.model,
        response_id: responseId,
        durationMs: Date.now() - t0,
        usage,
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

  // Batch unsupported in v1. We deliberately do NOT attach filesUpload /
  // batchCreate / batchGet / batchResults so `hasBatch()` short-circuits
  // cleanly on capabilities.batch === false. If a caller still calls one of
  // them via the optional method shape, throw an explicit capability error.
  function batchUnsupported(): never {
    throw new LlmCapabilityError("batch");
  }

  return {
    name: "anthropic",
    capabilities: CAPABILITIES,
    chat,
    // Explicit shims so tooling that inspects `typeof p.filesUpload` sees
    // `undefined`, matching the contract. (Left commented so hasBatch()'s
    // typeof checks return false.)
    // Don't attach batch* methods — see `hasBatch` type guard in provider.ts.
  } satisfies LlmProvider & { _batchUnsupported?: typeof batchUnsupported };
}

export const _capabilities: LlmCapabilities = CAPABILITIES;
