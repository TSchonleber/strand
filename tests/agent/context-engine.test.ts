import { NoOpContextEngine, SummarizingContextEngine, estimateTokens } from "@/agent";
import type { LlmCall, LlmMessage, LlmProvider, LlmResult, LlmUsage } from "@/clients/llm";
import { describe, expect, it } from "vitest";

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costInUsdTicks: 0,
};

function stubProvider(opts?: {
  maxContextTokens?: number;
  summaryText?: string;
  onCall?: (input: LlmCall) => void;
  throwOnSummarize?: boolean;
}): LlmProvider {
  const maxContextTokens = opts?.maxContextTokens ?? 1000;
  const summaryText =
    opts?.summaryText ?? "[compacted context]\nTook 3 steps, fs_read found the key.";
  return {
    name: "stub",
    capabilities: {
      structuredOutput: true,
      mcp: false,
      serverSideTools: [],
      batch: false,
      promptCacheKey: false,
      previousResponseId: false,
      functionToolLoop: true,
      computerUse: false,
      maxContextTokens,
    },
    async chat<T>(input: LlmCall): Promise<LlmResult<T>> {
      opts?.onCall?.(input);
      if (opts?.throwOnSummarize) {
        throw new Error("provider rejected compaction call");
      }
      return {
        outputText: summaryText,
        parsed: null,
        responseId: "summ_1",
        systemFingerprint: null,
        usage: { ...ZERO_USAGE, inputTokens: 400, outputTokens: 80 },
        toolCalls: [],
        rawResponse: {},
      } as unknown as LlmResult<T>;
    },
  };
}

function bigConversation(n: number): LlmMessage[] {
  const msgs: LlmMessage[] = [
    { role: "system", content: "You are a careful Strand sub-agent." },
    { role: "system", content: "Tools: fs_read, fs_write, http_fetch." },
  ];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: "user",
      content: `Step ${i}: do a detailed thing that describes lots of state.`,
    });
    msgs.push({
      role: "assistant",
      content: `I will do step ${i} by reading, processing, and writing files of substantial size.`,
    });
  }
  return msgs;
}

describe("NoOpContextEngine", () => {
  it("never compresses", async () => {
    const engine = new NoOpContextEngine();
    const msgs = bigConversation(50);
    const provider = stubProvider();
    const r = await engine.maybeCompress({
      messages: msgs,
      lastUsage: { ...ZERO_USAGE, inputTokens: 999_999 },
      provider,
    });
    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(msgs);
    expect(r.removed).toBe(0);
  });
});

describe("SummarizingContextEngine", () => {
  it("does nothing below threshold", async () => {
    const engine = new SummarizingContextEngine({ thresholdRatio: 0.75, keepTailTurns: 4 });
    const provider = stubProvider({ maxContextTokens: 100_000 });
    const msgs = bigConversation(5);
    const r = await engine.maybeCompress({
      messages: msgs,
      lastUsage: { ...ZERO_USAGE, inputTokens: 1000 },
      provider,
    });
    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it("compacts when input tokens cross threshold", async () => {
    let summaryCallInput: LlmCall | null = null;
    const engine = new SummarizingContextEngine({
      thresholdRatio: 0.5,
      keepTailTurns: 4,
      minMiddleSize: 0,
    });
    const provider = stubProvider({
      maxContextTokens: 1000,
      summaryText: "[compacted context]\nCompacted. Fs found X. Wrote Y.",
      onCall: (input) => {
        summaryCallInput = input;
      },
    });
    const msgs = bigConversation(20); // 42 messages total (2 sys + 40)
    const r = await engine.maybeCompress({
      messages: msgs,
      lastUsage: { ...ZERO_USAGE, inputTokens: 800 }, // > 500 threshold
      provider,
    });

    expect(r.compressed).toBe(true);
    expect(r.removed).toBeGreaterThan(0);
    // System block preserved byte-identically (cache anchor).
    expect(r.messages[0]).toBe(msgs[0]);
    expect(r.messages[1]).toBe(msgs[1]);
    // Summary user message injected right after the system head.
    const summary = r.messages[2];
    expect(summary?.role).toBe("user");
    expect(summary?.content).toContain("[compacted context]");
    // Tail preserved verbatim: the last 4 messages (== keepTailTurns).
    expect(r.messages.slice(-4)).toEqual(msgs.slice(-4));
    // Summary call had our stable cache key + static system prompt.
    expect(summaryCallInput?.promptCacheKey).toBe("strand:context:compress:v1");
    expect(summaryCallInput?.messages[0]?.role).toBe("system");
  });

  it("does not compact when middle is smaller than keepTail+min", async () => {
    const engine = new SummarizingContextEngine({
      thresholdRatio: 0.1,
      keepTailTurns: 20,
      minMiddleSize: 5,
    });
    const provider = stubProvider({ maxContextTokens: 1000 });
    const msgs = bigConversation(3); // small body
    const r = await engine.maybeCompress({
      messages: msgs,
      lastUsage: { ...ZERO_USAGE, inputTokens: 999 },
      provider,
    });
    expect(r.compressed).toBe(false);
  });

  it("survives summarizer failure gracefully", async () => {
    const engine = new SummarizingContextEngine({ thresholdRatio: 0.1, keepTailTurns: 2 });
    const provider = stubProvider({ throwOnSummarize: true, maxContextTokens: 1000 });
    const msgs = bigConversation(10);
    const r = await engine.maybeCompress({
      messages: msgs,
      lastUsage: { ...ZERO_USAGE, inputTokens: 999 },
      provider,
    });
    expect(r.compressed).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it("summary is prefixed with the [compacted context] marker automatically", async () => {
    const engine = new SummarizingContextEngine({
      thresholdRatio: 0.1,
      keepTailTurns: 2,
    });
    const provider = stubProvider({
      summaryText: "Raw summary without the marker.",
      maxContextTokens: 1000,
    });
    const msgs = bigConversation(10);
    const r = await engine.maybeCompress({
      messages: msgs,
      lastUsage: { ...ZERO_USAGE, inputTokens: 999 },
      provider,
    });
    expect(r.compressed).toBe(true);
    const summary = r.messages[2]?.content as string;
    expect(summary.startsWith("[compacted context]")).toBe(true);
    expect(summary).toContain("Raw summary without the marker.");
  });
});

describe("estimateTokens", () => {
  it("grows with message size + roughly matches 1 token ≈ 4 chars", () => {
    const a = estimateTokens([{ role: "user", content: "hi" }]);
    const b = estimateTokens([{ role: "user", content: "x".repeat(4000) }]);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeGreaterThan(900); // ~1000 tokens for 4000 chars + overhead
  });
});
