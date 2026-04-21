import { env } from "@/config";
import { log } from "@/util/log";
import { makeAnthropicProvider } from "./anthropic";
import { makeGeminiProvider } from "./gemini";
import { makeOpenAiProvider } from "./openai";
import { LlmCapabilityError, type LlmProvider } from "./provider";
import { makeXaiProvider } from "./xai";

/**
 * Provider factory. Selected by `env.LLM_PROVIDER`.
 *
 * Credentials come from the per-provider env vars (XAI_API_KEY,
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY). The factory validates
 * that the selected provider's key is set and throws a clear error if not.
 *
 * Singleton — constructed lazily on first call, reused thereafter. Call
 * `_resetLlmForTests()` in tests to force re-construction.
 */

let _provider: LlmProvider | null = null;

export function llm(): LlmProvider {
  if (_provider) return _provider;
  _provider = construct();
  log.info(
    {
      svc: "llm",
      provider: _provider.name,
      capabilities: _provider.capabilities,
    },
    "llm.initialized",
  );
  return _provider;
}

function construct(): LlmProvider {
  switch (env.LLM_PROVIDER) {
    case "xai": {
      if (!env.XAI_API_KEY) throw new Error("LLM_PROVIDER=xai requires XAI_API_KEY");
      return makeXaiProvider({ apiKey: env.XAI_API_KEY, baseURL: env.XAI_BASE_URL });
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) throw new Error("LLM_PROVIDER=openai requires OPENAI_API_KEY");
      return makeOpenAiProvider({
        apiKey: env.OPENAI_API_KEY,
        ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
      });
    }
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY)
        throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
      return makeAnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
      });
    }
    case "gemini": {
      if (!env.GEMINI_API_KEY) throw new Error("LLM_PROVIDER=gemini requires GEMINI_API_KEY");
      return makeGeminiProvider({ apiKey: env.GEMINI_API_KEY });
    }
  }
}

/** Test helper — clears the singleton so a new LLM_PROVIDER takes effect. */
export function _resetLlmForTests(): void {
  _provider = null;
}

export { hasBatch, LlmCapabilityError, LlmPrecheckError } from "./provider";
export type { LlmProvider } from "./provider";
export type {
  LlmBatchCreateArgs,
  LlmBatchHandle,
  LlmBatchResultLine,
  LlmCall,
  LlmCapabilities,
  LlmMessage,
  LlmResult,
  LlmStructuredOutput,
  LlmTool,
  LlmUsage,
} from "./types";

/** Required-capability helper — throws LlmCapabilityError if missing. */
export function requireCapability(p: LlmProvider, cap: keyof LlmProvider["capabilities"]): void {
  const v = p.capabilities[cap];
  if (!v || (Array.isArray(v) && v.length === 0)) {
    throw new LlmCapabilityError(cap as never);
  }
}
