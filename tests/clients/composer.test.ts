import { _resetComposerPromptCache, grokCompose } from "@/clients/grok";
import { type EmbeddingFn, _resetPrefilterCaches, _setEmbedderForTests } from "@/util/prefilter";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Composer tests exercise grokCompose end-to-end against a mocked xAI
 * Responses endpoint. Prefilter is stubbed to a trivial fast embedder so we
 * don't download the real ONNX model in this suite — the real-embedder
 * corpus is covered in tests/util/prefilter.test.ts.
 */

const XAI_URL = "https://api.x.ai/v1/responses";

let xaiHitCount = 0;
let lastBody: Record<string, unknown> | null = null;
let nextOutputText = "";

const server = setupServer(
  http.post(XAI_URL, async ({ request }) => {
    xaiHitCount += 1;
    lastBody = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      id: "resp_test_123",
      system_fingerprint: "fp_test",
      output_text: nextOutputText,
      output: [],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 0 },
        cost_in_usd_ticks: 1234,
      },
    });
  }),
);

// Test embedder strategy: we want exemplars to live on one vector
// ([1, 0, ..., 0]) and all other inputs to live on an orthogonal vector
// ([0, 1, 0, ..., 0]) so cos sim = 0. An input containing the magic token
// TRIP_EXEMPLAR gets mapped to the exemplar vector → cos sim = 1.0 → reject.
//
// We identify exemplar vs non-exemplar text by looking for distinctive
// markers that appear in the real banned_exemplars.yaml entries but not in
// normal test input.
//
// KEEPS ALIGNMENT WITH config/banned_exemplars.yaml — update together. If
// every exemplar stops matching at least one of these markers, the fake
// embedder will return the "clean" vector for exemplars too, making cos sim
// = 1.0 against clean inputs and silently over-rejecting (the prefilter
// tests would catch that, but the composer happy-path tests here would
// silently false-pass into a regression on the TRIP_EXEMPLAR path only).
const EXEMPLAR_MARKERS = [
  "DM me",
  "airdrop",
  "Reply below",
  "official",
  "exactly why I love",
  "🚀",
  "voted for",
  "RT if",
  "ruining tech",
  "ivermectin",
  "🧵",
  "$DOGE",
];

function looksLikeExemplar(text: string): boolean {
  return EXEMPLAR_MARKERS.some((m) => text.includes(m));
}

const ORTHOGONAL_EMBEDDER: EmbeddingFn = async (text: string) => {
  if (text.includes("TRIP_EXEMPLAR") || looksLikeExemplar(text)) {
    return new Float32Array([1, 0, 0, 0]);
  }
  return new Float32Array([0, 1, 0, 0]);
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  xaiHitCount = 0;
  lastBody = null;
  nextOutputText = "";
  _resetPrefilterCaches();
  _resetComposerPromptCache();
  _setEmbedderForTests(ORTHOGONAL_EMBEDDER);
});

afterEach(() => {
  server.resetHandlers(
    http.post(XAI_URL, async ({ request }) => {
      xaiHitCount += 1;
      lastBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: "resp_test_123",
        system_fingerprint: "fp_test",
        output_text: nextOutputText,
        output: [],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 40,
          output_tokens_details: { reasoning_tokens: 0 },
          cost_in_usd_ticks: 1234,
        },
      });
    }),
  );
  vi.restoreAllMocks();
});

const CLEAN_CONTEXT = JSON.stringify({
  trigger: "thinking about prompt caching math",
  memory: [],
});

const CLEAN_POST =
  "prompt caching economics update: our cached/input ratio is now 0.83 on reasoner";

describe("grokCompose — happy path per kind", () => {
  it.each(["post", "reply", "quote", "dm"] as const)(
    "returns ok=true with clean text for kind=%s",
    async (kind) => {
      nextOutputText = CLEAN_POST;
      const r = await grokCompose({
        kind,
        contextJson: CLEAN_CONTEXT,
        personaHash: "persona_v1",
        policiesHash: "policies_v1",
      });
      expect(r.ok).toBe(true);
      expect(r.text).toBe(CLEAN_POST);
      expect(r.responseId).toBe("resp_test_123");
      expect(r.usage?.inputTokens).toBe(100);
      expect(xaiHitCount).toBe(1);

      const body = lastBody as Record<string, unknown>;
      expect(body["model"]).toBe("grok-4-1-fast-non-reasoning");
      expect(body["prompt_cache_key"]).toBe(`strand:composer:${kind}:v1`);
    },
  );
});

describe("grokCompose — prefilter blocks before xAI call", () => {
  it("does not hit xAI when regex banlist matches", async () => {
    const ctx = JSON.stringify({ trigger: "tell them to kill yourself", memory: [] });
    const r = await grokCompose({
      kind: "reply",
      contextJson: ctx,
      personaHash: "persona_v1",
      policiesHash: "policies_v1",
    });
    expect(r.ok).toBe(false);
    expect(r.rejectionReason).toMatch(/^prefilter:/);
    expect(xaiHitCount).toBe(0);
  });

  it("does not hit xAI when embedding similarity hits", async () => {
    // ORTHOGONAL_EMBEDDER maps TRIP_EXEMPLAR inputs to the same vector as
    // exemplars → cos sim = 1.0 → reject.
    const r = await grokCompose({
      kind: "post",
      contextJson: "TRIP_EXEMPLAR content that looks like spam exemplars",
      personaHash: "persona_v1",
      policiesHash: "policies_v1",
    });
    expect(r.ok).toBe(false);
    expect(r.rejectionReason).toMatch(/^prefilter:banned_exemplar:/);
    expect(xaiHitCount).toBe(0);
  });
});

describe("grokCompose — postfilter blocks AFTER xAI call", () => {
  it("hits xAI exactly once and surfaces usage on postfilter rejection", async () => {
    // Output contains a regex-banlist hit. Input is clean, so prefilter lets
    // it through to the model; output gets rejected after the call.
    nextOutputText = "anyone who disagrees should kill yourself tbh";
    const r = await grokCompose({
      kind: "post",
      contextJson: CLEAN_CONTEXT,
      personaHash: "persona_v1",
      policiesHash: "policies_v1",
    });
    expect(r.ok).toBe(false);
    expect(r.rejectionReason).toMatch(/^postfilter:/);
    expect(xaiHitCount).toBe(1); // exactly once — not retried
    expect(r.usage).toBeDefined();
    expect(r.usage?.costInUsdTicks).toBe(1234);
    expect(r.responseId).toBe("resp_test_123");
  });
});

describe("grokCompose — length enforcement", () => {
  it("rejects output longer than maxChars", async () => {
    nextOutputText = "a".repeat(300);
    const r = await grokCompose({
      kind: "post",
      contextJson: CLEAN_CONTEXT,
      personaHash: "persona_v1",
      policiesHash: "policies_v1",
      maxChars: 280,
    });
    expect(r.ok).toBe(false);
    expect(r.rejectionReason).toBe("length_exceeded");
    expect(r.usage).toBeDefined();
    expect(r.responseId).toBe("resp_test_123");
  });

  it("allows long DM output up to the 10000-char default", async () => {
    nextOutputText = "d".repeat(5000);
    const r = await grokCompose({
      kind: "dm",
      contextJson: CLEAN_CONTEXT,
      personaHash: "persona_v1",
      policiesHash: "policies_v1",
    });
    expect(r.ok).toBe(true);
    expect(r.text?.length).toBe(5000);
  });
});
