import { MissingCredentialError, credentials } from "@/auth";
import type { CredentialStore } from "@/auth";
import { env } from "@/config";
import { log } from "@/util/log";
import { makeAnthropicProvider } from "./anthropic";
import { makeGeminiProvider } from "./gemini";
import { makeOpenAiProvider } from "./openai";
import { LlmCapabilityError, type LlmProvider } from "./provider";
import { makeXaiProvider } from "./xai";

/**
 * LLM provider factory.
 *
 * Provider selection: `env.LLM_PROVIDER` (xai | openai | anthropic | gemini).
 * Credentials: resolved lazily from a pluggable `CredentialStore`. Default
 * store is constructed via `credentials()` — selects between env / file /
 * env+file based on `STRAND_CREDENTIAL_STORE`.
 *
 * Bring-your-own-key:
 *   - Default: `llm()` reads keys from the default store (env-backed).
 *   - Override: `llm({ credentials: myStore })` — plug in a FileStore,
 *     OAuthStore, or a custom backend. The returned provider resolves its
 *     API key from the store at construction and caches it for the lifetime
 *     of the provider instance.
 *   - Reconstruct: `_resetLlmForTests()` clears the singleton; next call to
 *     `llm(opts)` rebuilds with new credentials.
 */

let _provider: LlmProvider | null = null;

export interface LlmFactoryOpts {
  /** Override the default credential store (BYOK). */
  credentials?: CredentialStore;
}

export async function llm(opts?: LlmFactoryOpts): Promise<LlmProvider> {
  if (_provider) return _provider;
  const store = opts?.credentials ?? credentials();
  _provider = await construct(store);
  log.info(
    {
      svc: "llm",
      provider: _provider.name,
      capabilities: _provider.capabilities,
      credential_store: store.name,
    },
    "llm.initialized",
  );
  return _provider;
}

async function construct(store: CredentialStore): Promise<LlmProvider> {
  switch (env.LLM_PROVIDER) {
    case "xai": {
      const apiKey = await store.get("XAI_API_KEY");
      if (!apiKey) throw new MissingCredentialError("XAI_API_KEY", store.name);
      return makeXaiProvider({ apiKey, baseURL: env.XAI_BASE_URL });
    }
    case "openai": {
      const apiKey = await store.get("OPENAI_API_KEY");
      if (!apiKey) throw new MissingCredentialError("OPENAI_API_KEY", store.name);
      const baseURL = (await store.get("OPENAI_BASE_URL")) ?? env.OPENAI_BASE_URL;
      return makeOpenAiProvider({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      });
    }
    case "anthropic": {
      const apiKey = await store.get("ANTHROPIC_API_KEY");
      if (!apiKey) throw new MissingCredentialError("ANTHROPIC_API_KEY", store.name);
      const baseURL = (await store.get("ANTHROPIC_BASE_URL")) ?? env.ANTHROPIC_BASE_URL;
      return makeAnthropicProvider({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      });
    }
    case "gemini": {
      const apiKey = await store.get("GEMINI_API_KEY");
      if (!apiKey) throw new MissingCredentialError("GEMINI_API_KEY", store.name);
      return makeGeminiProvider({ apiKey });
    }
  }
}

/** Test helper — clears the singleton so a new LLM_PROVIDER or store takes effect. */
export function _resetLlmForTests(): void {
  _provider = null;
}

export {
  hasBatch,
  hasBatchPoll,
  hasInlineBatch,
  LlmCapabilityError,
  LlmPrecheckError,
} from "./provider";
export type { LlmProvider } from "./provider";
export type {
  LlmBatchCreateArgs,
  LlmBatchCreateInlineArgs,
  LlmBatchHandle,
  LlmBatchResultLine,
  LlmCall,
  LlmCapabilities,
  LlmInlineBatchRequest,
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
