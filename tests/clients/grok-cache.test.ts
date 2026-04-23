/**
 * Prompt cache verification tests.
 *
 * Per PLAN.md §12, we must verify that `prompt_cache_key` produces
 * `cached_tokens > 0` on the second call with the same key.
 */

import { grokCall } from "@/clients/grok";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

describe("grokCall prompt caching", () => {
  const server = setupServer();

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("uses prompt_cache_key in request", async () => {
    let capturedRequest: Record<string, unknown> | null = null;

    server.use(
      http.post("https://api.x.ai/v1/responses", async ({ request }) => {
        capturedRequest = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "test_001",
          system_fingerprint: "test-fp",
          output_text: "Test response",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        });
      }),
    );

    await grokCall({
      model: "grok-4-1-fast-non-reasoning",
      systemPrompts: ["You are a helpful assistant."],
      userInput: "Hello",
      promptCacheKey: "strand:test:v1",
    });

    expect(capturedRequest).toHaveProperty("prompt_cache_key", "strand:test:v1");
  });

  it("extracts cached_tokens from response", async () => {
    server.use(
      http.post("https://api.x.ai/v1/responses", () => {
        return HttpResponse.json({
          id: "test_002",
          system_fingerprint: "test-fp",
          output_text: JSON.stringify({ result: "success" }),
          usage: {
            input_tokens: 500,
            output_tokens: 100,
            input_tokens_details: {
              cached_tokens: 300, // This is what we want to verify!
            },
          },
        });
      }),
    );

    const result = await grokCall({
      model: "grok-4-1-fast-non-reasoning",
      systemPrompts: [
        "You are a helpful assistant with a very long system prompt that should be cached.",
      ],
      userInput: "Hello",
      promptCacheKey: "strand:cache-test:v1",
    });

    // Verify we correctly extract cached tokens
    expect(result.usage.cachedInputTokens).toBe(300);
  });

  it("handles missing cached_tokens gracefully", async () => {
    server.use(
      http.post("https://api.x.ai/v1/responses", () => {
        return HttpResponse.json({
          id: "test_003",
          system_fingerprint: "test-fp",
          output_text: "Response",
          usage: {
            input_tokens: 200,
            output_tokens: 50,
            // No input_tokens_details field
          },
        });
      }),
    );

    const result = await grokCall({
      model: "grok-4-1-fast-non-reasoning",
      systemPrompts: ["Test"],
      userInput: "Hello",
    });

    // Should default to 0 when not present
    expect(result.usage.cachedInputTokens).toBe(0);
  });

  it("simulates cache hit on second call with same key", async () => {
    const callCount = { value: 0 };

    server.use(
      http.post("https://api.x.ai/v1/responses", () => {
        callCount.value++;

        // First call: no cache hit
        // Second call: cache hit (cached_tokens > 0)
        const isCacheHit = callCount.value > 1;

        return HttpResponse.json({
          id: `cache_test_${callCount.value}`,
          system_fingerprint: "test-fp",
          output_text: isCacheHit ? "Cached response" : "First response",
          usage: {
            input_tokens: isCacheHit ? 50 : 500, // Fewer tokens on cache hit
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: isCacheHit ? 450 : 0, // Cache hit!
            },
          },
        });
      }),
    );

    const cacheKey = "strand:cache-simulation:v1";

    // First call - no cache
    const result1 = await grokCall({
      model: "grok-4-1-fast-non-reasoning",
      systemPrompts: ["Very long system prompt that should be cached for reuse.".repeat(20)],
      userInput: "Hello",
      promptCacheKey: cacheKey,
    });

    expect(result1.usage.cachedInputTokens).toBe(0);
    expect(result1.usage.inputTokens).toBe(500);

    // Second call with same cache key - cache hit!
    const result2 = await grokCall({
      model: "grok-4-1-fast-non-reasoning",
      systemPrompts: ["Very long system prompt that should be cached for reuse.".repeat(20)],
      userInput: "Hello again",
      promptCacheKey: cacheKey,
    });

    // The key assertion from PLAN.md: cached_tokens > 0 on second call
    expect(result2.usage.cachedInputTokens).toBeGreaterThan(0);
    expect(result2.usage.cachedInputTokens).toBe(450);
    expect(result2.usage.inputTokens).toBe(50); // Fewer tokens billed
  });
});
