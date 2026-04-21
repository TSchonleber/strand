import type {
  LlmBatchCreateArgs,
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
 * `capabilities.batch === true`. Call `hasBatch(provider)` before using them.
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

  /** Optional capability group — all present or all absent. */
  filesUpload?(jsonl: string, purpose?: string): Promise<{ id: string }>;
  batchCreate?(args: LlmBatchCreateArgs): Promise<LlmBatchHandle>;
  batchGet?(id: string): Promise<LlmBatchHandle>;
  batchResults?(id: string): Promise<AsyncIterable<LlmBatchResultLine>>;

  /**
   * Build a single JSONL line for this provider's Batch API from an LlmCall.
   * Required when `capabilities.batch === true`. Non-batch providers throw
   * `LlmCapabilityError("batch")`.
   *
   * Consolidator uses this to generalize: `provider.buildBatchLine(call, id)`
   * gives a provider-native request body without leaking xAI specifics.
   */
  buildBatchLine?(call: LlmCall, customId: string): LlmBatchRequestLine;
}

/** Type guard — narrows provider so batch* methods are callable without `!`. */
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
