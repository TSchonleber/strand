import {
  type EmbeddingFn,
  _resetPrefilterCaches,
  _setEmbedderForTests,
  prefilterComposerText,
  prefilterText,
} from "@/util/prefilter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Prefilter tests.
 *
 * The sync fast path (`prefilterText`) covers regex + persona banned-topic
 * substring. It's what the policy gate calls — no embedding layer.
 *
 * The async composer path (`prefilterComposerText`) adds an embedding
 * similarity check against config/banned_exemplars.yaml. That's what the
 * composer calls to dodge xAI's $0.05/request refusal tax.
 *
 * The real-embedder corpus tests download the Xenova/bge-small-en-v1.5 ONNX
 * weights (~40MB) on first run to ~/.cache/huggingface. Subsequent runs hit
 * the local cache and are fast. CI timeouts are set to 180s to accommodate
 * first-time download.
 */

function fakeEmbedder(vectorFor: (text: string) => number[]): EmbeddingFn {
  return async (text: string) => new Float32Array(vectorFor(text));
}

const ZERO_EMBEDDER: EmbeddingFn = async () => new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);

afterEach(() => {
  _resetPrefilterCaches();
});

// ─── Sync fast path ───────────────────────────────────────────

describe("prefilterText (sync, policy-gate path)", () => {
  it("rejects regex profanity banlist hits", () => {
    const r = prefilterText("you should kill yourself over this bug");
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("matches_pattern:"))).toBe(true);
  });

  it("rejects the short-form kys", () => {
    const r = prefilterText("just kys already lmao");
    expect(r.ok).toBe(false);
  });

  it("rejects content containing a banned_topics entry", () => {
    const r = prefilterText("here's my hot take on partisan politics and why it's so obvious");
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("banned_topic:"))).toBe(true);
  });

  it("passes clean on-persona technical content", () => {
    const r = prefilterText(
      "p99 latency dropped 40% after we switched to streaming jsonl tool outputs",
    );
    expect(r.ok).toBe(true);
  });
});

// ─── Async composer path (injected embedder) ──────────────────

describe("prefilterComposerText — cheap layers short-circuit before embedding", () => {
  beforeEach(() => {
    _setEmbedderForTests(ZERO_EMBEDDER);
  });

  it("rejects on regex without touching the embedder", async () => {
    const r = await prefilterComposerText("tell them to kill yourself");
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("matches_pattern:"))).toBe(true);
  });

  it("rejects on banned topic without touching the embedder", async () => {
    const r = await prefilterComposerText("my take on partisan politics");
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("banned_topic:"))).toBe(true);
  });
});

describe("prefilterComposerText — embedder kill switch", () => {
  it("refuses everything when the embedder factory throws", async () => {
    _setEmbedderForTests(async () => {
      throw new Error("onnx_runtime_init_failed");
    });
    const r = await prefilterComposerText(
      "totally benign technical post about prompt caching ratios",
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("embedder_") || x.startsWith("embedding_"))).toBe(
      true,
    );
  });
});

describe("prefilterComposerText — embedding similarity (injected vectors)", () => {
  it("rejects input that embeds onto the same vector as the cached exemplars", async () => {
    // Map every string to the same unit vector → every exemplar vector is
    // identical to the input vector → cos sim = 1.0 → reject.
    _setEmbedderForTests(fakeEmbedder(() => [1, 0, 0, 0, 0, 0, 0, 0]));
    const r = await prefilterComposerText("ostensibly-clean text");
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("banned_exemplar:"))).toBe(true);
    expect(r.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it("passes when input is orthogonal to every exemplar vector", async () => {
    // Exemplars all embed to [0, 1, 0, ...]; input embeds to [1, 0, 0, ...].
    _setEmbedderForTests(
      fakeEmbedder((text) =>
        text.includes("INPUT_MARKER") ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0],
      ),
    );
    const r = await prefilterComposerText("INPUT_MARKER clean technical claim");
    expect(r.ok).toBe(true);
    expect(r.similarity).toBeLessThan(0.8);
  });
});

// ─── Real-embedder corpus tests ────────────────────────────────

const SYNTHETIC_BANNED_PARAPHRASES = [
  "Slide into my DMs and I'll share my premium 100x signals group, only a few spots left",
  "Claim your free $ETH airdrop now by connecting your wallet to this site",
  "What's the first framework you learned? Comment below and I'll RT my favorites",
  "I'm the real Vitalik's backup account, follow for alpha before anyone else sees it",
  "This community is literally the greatest on earth, you all are amazing 🙏",
  "🔥 My new course on scaling your twitter to 100k in 60 days is live, grab it here https://example.com",
  "If you support the other party you are actively making this country worse",
  "Retweet if you hustle at 4am, like if you never sleep",
  "Those people need to be removed from every tech company immediately",
  "Forget doctors, just take megadose vitamin D and ivermectin daily, worked for me",
  "🧵 1/ I read 500 books about billionaires, here are the 21 habits that will change your life",
  "$DOGE going to $5 by next month, load up now or cry later",
];

const CLEAN_ON_PERSONA_CORPUS = [
  "switched our retrieval from pgvector to qdrant and p99 dropped from 420ms to 85ms at 12m rows",
  "most agent frameworks are a switch statement and a retry loop with extra vocabulary",
  "finally got prompt caching working end-to-end. cached_tokens / input_tokens ratio now 0.83 on the reasoner",
  "inference economics update: reasoning models are 10x cheaper if you stop sending them junk context",
  "spent two hours debugging a bug that was just a missing await in a streaming handler",
  "evals are the bottleneck. everything else is tractable once you have a faithful eval set",
  "shipped a tiny mcp server today that wraps our internal graph db. took 90 minutes",
  "the slow thing is almost never the model. profile first, tune second",
  "rust tokio is finally clicking after a week of pretending to understand pin projection",
  "tool-use traces are the richest eval signal we have. we're logging every tool call for replay",
  "our long-horizon memory recall cliffs at session 6. still looking for a clean fix",
  "sqlite wal mode plus a single writer thread beats the fancy distributed thing for our load",
  "a2a protocol feels undercooked but the direction is right. interop beats moats in this space",
  "replaying production traces nightly catches drift that golden-dataset evals miss",
  "turns out the reasoning tax is mostly an artifact of how you count cached input tokens",
  "our p95 tool latency is now dominated by dns resolution, not the api call",
  "finally deleted 12k lines of agent orchestration code in favor of a typestate policy gate",
  "if your retrieval pipeline has more hyperparameters than your model does, something is wrong",
  "small team lesson: one shared queue beats three clever ones you have to explain",
  "the single best observability upgrade we shipped this quarter was response id on every grok call",
];

describe("prefilterComposerText — real-embedder corpora", () => {
  beforeEach(() => {
    _resetPrefilterCaches();
  });

  it(
    "rejects at least 9 of 12 synthetic banned paraphrases",
    async () => {
      let rejected = 0;
      for (const s of SYNTHETIC_BANNED_PARAPHRASES) {
        const r = await prefilterComposerText(s);
        if (!r.ok) rejected += 1;
      }
      expect(rejected).toBeGreaterThanOrEqual(9);
    },
    { timeout: 180_000 },
  );

  it(
    "passes at least 19 of 20 clean on-persona strings",
    async () => {
      let passed = 0;
      for (const s of CLEAN_ON_PERSONA_CORPUS) {
        const r = await prefilterComposerText(s);
        if (r.ok) passed += 1;
      }
      expect(passed).toBeGreaterThanOrEqual(19);
    },
    { timeout: 180_000 },
  );
});
