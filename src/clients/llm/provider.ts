import type {
  LlmBatchCreateArgs,
  LlmBatchCreateInlineArgs,
  LlmBatchHandle,
  LlmBatchRequestLine,
  LlmBatchResultLine,
  LlmCall,
  LlmCapabilities,
  LlmResult,
} from "./types";

/**
 * The universal LLM surface Strand loops call against.
 *
 * Adapters MUST implement `chat` + declare `capabilities`.
 * Batch methods are optional — only present on providers where
 * `capabilities.batch === true`. Two transport shapes are supported:
 *
 *  - file-based (xAI, OpenAI): `filesUpload` + `batchCreate({inputFileId})`
 *    + `batchGet` + `batchResults`. Use `hasBatch(provider)` to narrow.
 *  - inline (Anthropic): `batchCreateInline({requests})` + `batchGet` +
 *    `batchResults`. Use `hasInlineBatch(provider)` to narrow.
 *
 * A provider may support exactly one shape. Callers should try `hasInlineBatch`
 * first (no file-upload round-trip) and fall back to `hasBatch`.
 */
export interface LlmProvider {
  readonly name: "openai" | "anthropic" | "xai" | "gemini" | string;
  readonly capabilities: LlmCapabilities;

  /**
   * Synchronous inference. Every adapter implements this. Reasoning-only
   * models: adapter strips incompatible params (temperature, presence_penalty,
   * frequency_penalty, stop, reasoning_effort, logprobs).
   */
  chat<T = unknown>(input: LlmCall): Promise<LlmResult<T>>;

  // File-based batch (xAI, OpenAI). Present together or not at all.
  filesUpload?(jsonl: string, purpose?: string): Promise<{ id: string }>;
  batchCreate?(args: LlmBatchCreateArgs): Promise<LlmBatchHandle>;

  // Inline batch (Anthropic). Present instead of `batchCreate` + `filesUpload`.
  batchCreateInline?(args: LlmBatchCreateInlineArgs): Promise<LlmBatchHandle>;

  // Shared polling + results. Required whenever EITHER batch path is present.
  batchGet?(id: string): Promise<LlmBatchHandle>;
  batchResults?(id: string): Promise<AsyncIterable<LlmBatchResultLine>>;

  /**
   * Build a single JSONL-style request line from an LlmCall. Required when
   * `capabilities.batch === true`. For file-based providers this is the line
   * that's concatenated into the uploaded JSONL; for inline providers it's
   * used to derive `{custom_id, body}` pairs (the method/url envelope is
   * discarded — inline providers don't need it).
   */
  buildBatchLine?(call: LlmCall, customId: string): LlmBatchRequestLine;
}

/**
 * Type guard — narrows provider so the file-based batch methods are callable
 * without `!`. True only when the provider exposes the full file-upload
 * pipeline (xAI, OpenAI).
 */
export function hasBatch(
  p: LlmProvider,
): p is LlmProvider &
  Required<Pick<LlmProvider, "filesUpload" | "batchCreate" | "batchGet" | "batchResults">> {
  return (
    p.capabilities.batch &&
    typeof p.filesUpload === "function" &&
    typeof p.batchCreate === "function" &&
    typeof p.batchGet === "function" &&
    typeof p.batchResults === "function"
  );
}

/**
 * Type guard — narrows provider so the inline batch methods are callable
 * without `!`. True only when the provider exposes the inline-create pipeline
 * (Anthropic).
 */
export function hasInlineBatch(
  p: LlmProvider,
): p is LlmProvider &
  Required<Pick<LlmProvider, "batchCreateInline" | "batchGet" | "batchResults">> {
  return (
    p.capabilities.batch &&
    typeof p.batchCreateInline === "function" &&
    typeof p.batchGet === "function" &&
    typeof p.batchResults === "function"
  );
}

/**
 * True when the provider can be polled for batch status + results regardless
 * of which submission shape it supports. Used by pollers that don't care how
 * the batch was submitted — they just read state.
 */
export function hasBatchPoll(
  p: LlmProvider,
): p is LlmProvider & Required<Pick<LlmProvider, "batchGet" | "batchResults">> {
  return (
    p.capabilities.batch && typeof p.batchGet === "function" && typeof p.batchResults === "function"
  );
}

/**
 * Common refusal / precheck error thrown by adapters before hitting the wire
 * (content-policy block, missing required feature, etc.). Lets Reasoner /
 * Consolidator distinguish "local rejection" from "provider outage".
 */
export class LlmPrecheckError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "LlmPrecheckError";
  }
}

/** Adapters throw this when a required capability is missing. */
export class LlmCapabilityError extends Error {
  constructor(capability: keyof LlmCapabilities | "batch" | "mcp" | "previousResponseId") {
    super(`provider does not support required capability: ${String(capability)}`);
    this.name = "LlmCapabilityError";
  }
}
