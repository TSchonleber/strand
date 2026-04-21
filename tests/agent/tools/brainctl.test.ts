import { describe, expect, it, vi } from "vitest";

// Mock the brain client BEFORE importing the tools.
vi.mock("@/clients/brain", () => ({
  brain: {
    memory_search: vi.fn(async (args: unknown) => ({ results: [{ echoed: args }] })),
    entity_get: vi.fn(async (args: unknown) => ({ entity: args })),
  },
}));

import { makeBrainEntityGet, makeBrainMemorySearch } from "@/agent/tools/brainctl";
import { makeCtx } from "./helpers";

describe("brain_memory_search", () => {
  it("forwards args and returns brain.memory_search result", async () => {
    const tool = makeBrainMemorySearch();
    const out = (await tool.execute({ query: "hello", limit: 3 }, makeCtx())) as {
      results: Array<{ echoed: Record<string, unknown> }>;
    };
    expect(out.results[0]?.echoed).toMatchObject({ query: "hello", limit: 3 });
  });
});

describe("brain_entity_get", () => {
  it("forwards identifier and returns brain.entity_get result", async () => {
    const tool = makeBrainEntityGet();
    const out = (await tool.execute({ handle: "@alice" }, makeCtx())) as {
      entity: Record<string, unknown>;
    };
    expect(out.entity).toEqual({ handle: "@alice" });
  });
});
