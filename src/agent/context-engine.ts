/**
 * ContextEngine — compaction before the context window fills.
 *
 * Strand-native design, NOT a Hermes port:
 *   - Operates on our LlmMessage[] shape, not OpenAI-format dicts.
 *   - Preserves the byte-stable system + tool prefix so compaction NEVER busts
 *     the prompt cache for the shared prefix.
 *   - Compresses the user/assistant/tool MIDDLE only; keeps the final N turns
 *     verbatim so the tail stays current.
 *   - Summarizer call has its own stable promptCacheKey so the summarizer
 *     itself benefits from caching across compaction events.
 *   - Off by default (NoOpContextEngine). Opt in at the call site.
 *
 * Pattern from: NousResearch/hermes-agent (`agent/context_engine.py`). Interface
 * redesigned for our types; implementation rewritten.
 */

import type { LlmMessage, LlmProvider, LlmUsage } from "@/clients/llm";
import { log } from "@/util/log";

/**
 * Caller gives the engine the messages + last-known usage; engine returns
 * either the same list unchanged or a compacted version. `compressed` is true
 * whenever the engine mutated the list.
 */
export interface CompressResult {
  messages: LlmMessage[];
  compressed: boolean;
  /** Rough token-count estimate post-compaction. Best-effort, for logging. */
  estimatedTokens: number;
  /** Count of messages removed + replaced. Zero when compressed=false. */
  removed: number;
}

export interface ContextEngine {
  readonly name: string;
  /**
   * Decide + act. Returns either the same messages or a new (shorter) list.
   * MUST preserve the leading system messages byte-identically — that prefix
   * is cache-load-bearing.
   */
  maybeCompress(args: {
    messages: LlmMessage[];
    /** Last observed usage from the previous chat() call, or null on first tick. */
    lastUsage: LlmUsage | null;
    /** Provider used for both the calling loop and the summarizer. */
    provider: LlmProvider;
  }): Promise<CompressResult>;
}

// ─── No-op default ────────────────────────────────────────────────────────

/** Never compresses. The default — operators opt in to compaction explicitly. */
export class NoOpContextEngine implements ContextEngine {
  readonly name = "noop";
  async maybeCompress(args: {
    messages: LlmMessage[];
    lastUsage: LlmUsage | null;
    provider: LlmProvider;
  }): Promise<CompressResult> {
    return {
      messages: args.messages,
      compressed: false,
      estimatedTokens: args.lastUsage?.inputTokens ?? 0,
      removed: 0,
    };
  }
}

// ─── Summarizing default ─────────────────────────────────────────────────

/** Rough 1 token ≈ 4 chars estimate. Good enough for threshold decisions; real token counts come back in usage. */
function estimateTokens(messages: readonly LlmMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 16; // 16 for role + overhead
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        chars += JSON.stringify(tc.args ?? {}).length + tc.name.length + 16;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export interface SummarizingContextEngineOpts {
  /** Fraction of provider.capabilities.maxContextTokens to trigger compaction at. Default 0.75. */
  thresholdRatio?: number;
  /** Keep the last N conversation turns (non-system) verbatim. Default 8. */
  keepTailTurns?: number;
  /** Model id for the summarizer call. Defaults to LLM_MODEL_COMPOSER, then LLM_MODEL_REASONER, then a literal. */
  summarizerModel?: string;
  /** Summarizer maxOutputTokens. Default 800. */
  summarizerMaxOutputTokens?: number;
  /** Hard floor — never compact below this many messages (below the tail). Default 0. */
  minMiddleSize?: number;
}

const COMPRESS_CACHE_KEY = "strand:context:compress:v1";

const COMPRESS_SYSTEM = [
  "You are a conversation summarizer for an autonomous agent harness.",
  "",
  "You receive the MIDDLE of an agent conversation — a sequence of user requests,",
  "assistant responses, tool calls, and tool results. Produce a faithful,",
  "compact summary that preserves the load-bearing facts:",
  "  - decisions made and reasons",
  "  - tool calls executed + their outcomes (success/failure + key return values)",
  "  - user requests or clarifications",
  "  - discovered facts, constraints, file paths, identifiers",
  "",
  "Rules:",
  "- Be terse. One paragraph per distinct subtopic. No filler.",
  "- Preserve specific identifiers (file paths, URLs, tool names, error codes).",
  "- Do NOT invent facts. If something is uncertain, say so.",
  "- Do NOT include meta-commentary about the summarization task.",
  "- Start the output with the literal marker: [compacted context]",
].join("\n");

/**
 * Summarizes the middle of the conversation via a cheap LLM call. Preserves
 * the leading system messages and the last N turns verbatim.
 *
 * Compaction layout (before → after):
 *   [sys...][user_1][asst_1][tool_r_1]...[user_k][asst_k]
 *   [sys...][summary_user_msg][user_{k-N+1}][asst_{k-N+1}]...[user_k][asst_k]
 */
export class SummarizingContextEngine implements ContextEngine {
  readonly name = "summarizing";
  private readonly opts: Required<
    Pick<
      SummarizingContextEngineOpts,
      "thresholdRatio" | "keepTailTurns" | "summarizerMaxOutputTokens" | "minMiddleSize"
    >
  > & { summarizerModel?: string };

  constructor(opts: SummarizingContextEngineOpts = {}) {
    const resolved: Required<
      Pick<
        SummarizingContextEngineOpts,
        "thresholdRatio" | "keepTailTurns" | "summarizerMaxOutputTokens" | "minMiddleSize"
      >
    > & { summarizerModel?: string } = {
      thresholdRatio: opts.thresholdRatio ?? 0.75,
      keepTailTurns: opts.keepTailTurns ?? 8,
      summarizerMaxOutputTokens: opts.summarizerMaxOutputTokens ?? 800,
      minMiddleSize: opts.minMiddleSize ?? 0,
    };
    if (opts.summarizerModel !== undefined) {
      resolved.summarizerModel = opts.summarizerModel;
    }
    this.opts = resolved;
  }

  async maybeCompress(args: {
    messages: LlmMessage[];
    lastUsage: LlmUsage | null;
    provider: LlmProvider;
  }): Promise<CompressResult> {
    const { messages, lastUsage, provider } = args;
    const maxContext = provider.capabilities.maxContextTokens;
    const threshold = Math.floor(maxContext * this.opts.thresholdRatio);
    const observed = lastUsage?.inputTokens ?? estimateTokens(messages);

    if (observed < threshold) {
      return { messages, compressed: false, estimatedTokens: observed, removed: 0 };
    }

    // Preserve leading system block verbatim (shared prefix — cache anchor).
    const sysEnd = messages.findIndex((m) => m.role !== "system");
    const systemHead = sysEnd === -1 ? messages : messages.slice(0, sysEnd);
    const body = sysEnd === -1 ? [] : messages.slice(sysEnd);

    if (body.length <= this.opts.keepTailTurns + this.opts.minMiddleSize) {
      // Not enough middle to compress — accept the overage, log a warn.
      log.warn(
        {
          svc: "agent",
          engine: this.name,
          observedTokens: observed,
          threshold,
          bodyLength: body.length,
        },
        "context.compact.skipped_insufficient_middle",
      );
      return { messages, compressed: false, estimatedTokens: observed, removed: 0 };
    }

    const middle = body.slice(0, body.length - this.opts.keepTailTurns);
    const tail = body.slice(body.length - this.opts.keepTailTurns);

    const middleText = renderForSummary(middle);
    let summaryText: string;
    try {
      const model = this.resolveSummarizerModel(provider);
      const result = await provider.chat({
        model,
        messages: [
          { role: "system", content: COMPRESS_SYSTEM },
          { role: "user", content: middleText },
        ],
        promptCacheKey: COMPRESS_CACHE_KEY,
        maxOutputTokens: this.opts.summarizerMaxOutputTokens,
      });
      summaryText = result.outputText.trim();
      if (!summaryText.startsWith("[compacted context]")) {
        summaryText = `[compacted context]\n${summaryText}`;
      }
    } catch (err) {
      log.warn({ svc: "agent", engine: this.name, err }, "context.compact.summarizer_failed");
      return { messages, compressed: false, estimatedTokens: observed, removed: 0 };
    }

    const compacted: LlmMessage[] = [
      ...systemHead,
      { role: "user", content: summaryText },
      ...tail,
    ];
    const estimatedTokens = estimateTokens(compacted);

    log.info(
      {
        svc: "agent",
        engine: this.name,
        observedTokens: observed,
        threshold,
        removedMessages: middle.length,
        tailTurns: tail.length,
        summaryChars: summaryText.length,
        estimatedTokensAfter: estimatedTokens,
      },
      "context.compact.applied",
    );

    return {
      messages: compacted,
      compressed: true,
      estimatedTokens,
      removed: middle.length,
    };
  }

  private resolveSummarizerModel(provider: LlmProvider): string {
    if (this.opts.summarizerModel) return this.opts.summarizerModel;
    const cheap = process.env["LLM_MODEL_COMPOSER"];
    if (cheap && cheap.length > 0) return cheap;
    const reasoner = process.env["LLM_MODEL_REASONER"];
    if (reasoner && reasoner.length > 0) return reasoner;
    void provider;
    return "grok-4-1-fast-non-reasoning";
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function renderForSummary(messages: readonly LlmMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      lines.push(`[tool_result id=${m.toolCallId ?? "?"}]\n${m.content}`);
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        const args = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args);
        lines.push(`[tool_call name=${tc.name}]\n${args}`);
      }
      if (m.content) lines.push(`[assistant]\n${m.content}`);
      continue;
    }
    lines.push(`[${m.role}]\n${m.content}`);
  }
  return lines.join("\n\n");
}

// Re-export the estimator so the loop + plan-runner can log estimates cheaply.
export { estimateTokens };
