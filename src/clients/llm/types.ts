/**
 * Provider-agnostic LLM types.
 *
 * Strand's core loops (Reasoner, Consolidator, Composer) call the `LlmProvider`
 * interface. Per-provider adapters live in sibling files (openai.ts,
 * anthropic.ts, xai.ts, gemini.ts) and translate these types to each provider's
 * native wire format.
 *
 * Design bias: lean over complete. We normalize the fields every loop actually
 * uses. Provider-specific knobs that don't generalize (reasoning.effort,
 * thinking.budget_tokens, safety_settings, etc.) go through `providerOptions`
 * as opaque passthrough. No clever multi-way mapping.
 */

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface LlmStructuredOutput {
  name: string;
  schema: Record<string, unknown>;
  /** Whether the schema MUST be enforced. Some providers ignore false (Anthropic). */
  strict?: boolean;
}

export interface LlmFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

/**
 * Provider-native server-side tools (xAI `x_search`, OpenAI `web_search_preview`,
 * Anthropic `web_search_20250305`, Gemini `google_search_retrieval`).
 * Adapters check `capabilities.serverSideTools` and silently drop unknown types.
 */
export interface LlmServerTool {
  type: string;
  [k: string]: unknown;
}

/** Remote MCP tool. xAI + OpenAI (Responses API) + Anthropic support; Gemini does not as of 2026-04. */
export interface LlmMcpTool {
  type: "mcp";
  server_label: string;
  server_url: string;
  server_description?: string;
  authorization?: string;
  headers?: Record<string, string>;
  allowed_tools?: string[];
}

export type LlmTool = LlmFunctionTool | LlmServerTool | LlmMcpTool;

export type LlmToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } };

export interface LlmCall {
  model: string;
  /**
   * Full message list including system messages. Adapters route to each
   * provider's system field vs first-message convention.
   */
  messages: LlmMessage[];
  tools?: LlmTool[];
  toolChoice?: LlmToolChoice;
  parallelToolCalls?: boolean;
  /** Cap agentic tool chains. xAI: max_turns. OpenAI: tool_choice loop count. */
  maxTurns?: number;
  /** Dropped by adapters for reasoning-only models that reject it. */
  temperature?: number;
  maxOutputTokens?: number;
  structuredOutput?: LlmStructuredOutput;
  /**
   * xAI, OpenAI Responses honor natively. Anthropic maps to `cache_control`
   * breakpoints. Gemini ignores (auto context caching on Pro tier). Adapters
   * translate or no-op.
   */
  promptCacheKey?: string;
  /**
   * Provider-specific `include` flags. xAI: `["mcp_call_output", "reasoning.encrypted_content", ...]`.
   * OpenAI: `["message.output_text.logprobs", ...]`. Adapters pass through what they recognize, drop rest.
   */
  include?: string[];
  /** Server-stored conversation continuation. xAI + OpenAI Responses. Others ignored. */
  previousResponseId?: string;
  /** Opt out of server-side storage. Disables `previousResponseId` chaining on the same call. */
  store?: boolean;
  /** Escape hatch for provider-specific knobs without enlarging this interface. */
  providerOptions?: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Normalized cost meter: integer 1e-10 USD units. Divide by 1e10 for dollars. */
  costInUsdTicks: number;
}

export interface LlmToolCall {
  name: string;
  args: unknown;
}

export interface LlmResult<T = unknown> {
  outputText: string;
  parsed: T | null;
  responseId: string;
  systemFingerprint: string | null;
  usage: LlmUsage;
  toolCalls: LlmToolCall[];
  rawResponse: unknown;
}

/**
 * What a provider can do. Loops consult this to decide whether to submit via
 * Batch vs sync, whether to set `prompt_cache_key`, etc. No runtime fallback
 * magic — capabilities are declared up front.
 */
export interface LlmCapabilities {
  /** Native JSON-schema structured output. */
  structuredOutput: boolean;
  /** Remote MCP tool spec. */
  mcp: boolean;
  /** Provider-native server-side tools supported, by `type` string. */
  serverSideTools: readonly string[];
  /** Batch API (file upload + batch create + results stream). */
  batch: boolean;
  /** Honors `prompt_cache_key` or equivalent explicit cache control. */
  promptCacheKey: boolean;
  /** Supports `previous_response_id` for stored-conversation continuation. */
  previousResponseId: boolean;
  /** Soft guardrail for callers. */
  maxContextTokens: number;
}

// ─── Batch API (optional capability) ────────────────────────────────────────

export interface LlmBatchRequestLine {
  custom_id: string;
  method: "POST";
  url: string;
  body: Record<string, unknown>;
}

export type LlmBatchStatus =
  | "validating"
  | "in_progress"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

export interface LlmBatchHandle {
  id: string;
  status: LlmBatchStatus;
  input_file_id: string;
  output_file_id?: string;
  error_file_id?: string;
  created_at: number;
  completed_at?: number;
  request_counts?: { total: number; completed: number; failed: number };
  endpoint?: string;
  completion_window?: string;
}

export interface LlmBatchResultLine {
  id: string;
  custom_id: string;
  response?: { status_code: number; body: Record<string, unknown> };
  error?: { code: string; message: string };
}

export interface LlmBatchCreateArgs {
  inputFileId: string;
  /** Provider-specific. xAI: "/v1/responses" or "/v1/chat/completions". OpenAI: same. */
  endpoint?: string;
  /** xAI + OpenAI accept "24h". */
  completionWindow?: string;
  /** Metadata pass-through. */
  metadata?: Record<string, string>;
}
