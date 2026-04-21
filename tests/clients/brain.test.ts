import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * We mock the MCP SDK `Client` so brain.ts talks to a stub instead of
 * spawning a brainctl subprocess. Each test resets the mock and installs
 * its own `callTool` behavior.
 */

const callToolMock = vi.fn();
const connectMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => ({
    connect: connectMock,
    close: closeMock,
    callTool: callToolMock,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(() => ({})),
}));

// Avoid actually spawning brainctl.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stderr: { on: vi.fn() },
    kill: vi.fn(),
  })),
}));

function okResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

describe("brain client", () => {
  beforeEach(() => {
    callToolMock.mockReset();
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    closeMock.mockReset();
    closeMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { disconnect } = await import("@/clients/brain");
    await disconnect();
    vi.resetModules();
  });

  it("GROK_READ_TOOLS excludes every destructive write tool", async () => {
    const { GROK_READ_TOOLS } = await import("@/clients/brain");
    const forbidden = [
      "memory_add",
      "memory_promote",
      "entity_create",
      "entity_merge",
      "event_add",
      "belief_set",
      "policy_add",
      "policy_feedback",
      "budget_set",
      "trust_calibrate",
      "backup",
      "quarantine_purge",
    ];
    for (const f of forbidden) {
      expect(GROK_READ_TOOLS).not.toContain(f);
    }
  });

  it("GROK_CONSOLIDATOR_TOOLS adds consolidator reads but still excludes mutations", async () => {
    const { GROK_CONSOLIDATOR_TOOLS } = await import("@/clients/brain");
    const required = [
      "reflexion_write",
      "dream_cycle",
      "consolidation_run",
      "gaps_scan",
      "retirement_analysis",
    ];
    for (const r of required) expect(GROK_CONSOLIDATOR_TOOLS).toContain(r);

    const forbidden = [
      "memory_add",
      "memory_promote",
      "entity_create",
      "entity_merge",
      "event_add",
      "belief_set",
      "policy_add",
      "policy_feedback",
      "budget_set",
      "trust_calibrate",
      "backup",
      "quarantine_purge",
    ];
    for (const f of forbidden) expect(GROK_CONSOLIDATOR_TOOLS).not.toContain(f);
  });

  it("memory_promote forwards the right tool name and args", async () => {
    callToolMock.mockResolvedValue(okResult({ promoted: true }));
    const { brain } = await import("@/clients/brain");
    await brain.memory_promote({ id: "mem_123" });
    expect(callToolMock).toHaveBeenCalledTimes(1);
    const call = callToolMock.mock.calls[0]?.[0];
    expect(call.name).toBe("memory_promote");
    expect(call.arguments).toMatchObject({ id: "mem_123" });
    expect(call.arguments.agent_id).toBeTruthy();
  });

  it("entity_merge forwards from_ids and into_id", async () => {
    callToolMock.mockResolvedValue(okResult({ merged: 2 }));
    const { brain } = await import("@/clients/brain");
    await brain.entity_merge({ from_ids: ["e1", "e2"], into_id: "e3" });
    const call = callToolMock.mock.calls[0]?.[0];
    expect(call.name).toBe("entity_merge");
    expect(call.arguments.from_ids).toEqual(["e1", "e2"]);
    expect(call.arguments.into_id).toBe("e3");
  });

  it("belief_set forwards key/value/scope", async () => {
    callToolMock.mockResolvedValue(okResult({}));
    const { brain } = await import("@/clients/brain");
    await brain.belief_set({ key: "tone", value: "dry", scope: "persona" });
    const call = callToolMock.mock.calls[0]?.[0];
    expect(call.name).toBe("belief_set");
    expect(call.arguments).toMatchObject({ key: "tone", value: "dry", scope: "persona" });
  });

  it("trust_calibrate forwards memory_id and outcome", async () => {
    callToolMock.mockResolvedValue(okResult({}));
    const { brain } = await import("@/clients/brain");
    await brain.trust_calibrate({ memory_id: "mem_9", outcome: "success" });
    const call = callToolMock.mock.calls[0]?.[0];
    expect(call.name).toBe("trust_calibrate");
    expect(call.arguments).toMatchObject({ memory_id: "mem_9", outcome: "success" });
  });

  it("context_search forwards query/limit and returns parsed payload", async () => {
    callToolMock.mockResolvedValue(okResult({ results: [{ id: "m1" }] }));
    const { brain } = await import("@/clients/brain");
    const res = await brain.context_search({ query: "hello", limit: 5 });
    expect(res).toEqual({ results: [{ id: "m1" }] });
    const call = callToolMock.mock.calls[0]?.[0];
    expect(call.name).toBe("context_search");
    expect(call.arguments).toMatchObject({ query: "hello", limit: 5 });
  });

  it("temporal_map forwards `since` arg", async () => {
    callToolMock.mockResolvedValue(okResult({ map: {} }));
    const { brain } = await import("@/clients/brain");
    await brain.temporal_map({ since: "2026-04-01T00:00:00Z" });
    const call = callToolMock.mock.calls[0]?.[0];
    expect(call.name).toBe("temporal_map");
    expect(call.arguments.since).toBe("2026-04-01T00:00:00Z");
  });

  it("batchReads happy path: all three ops resolve", async () => {
    callToolMock.mockImplementation((req: { name: string }) => {
      if (req.name === "memory_search") return Promise.resolve(okResult({ r: "m" }));
      if (req.name === "entity_search") return Promise.resolve(okResult({ r: "e" }));
      return Promise.resolve(okResult({ r: "o" }));
    });
    const { brain } = await import("@/clients/brain");
    const res = await brain.batchReads([
      { tool: "memory_search", args: { q: "a" } },
      { tool: "entity_search", args: { q: "b" } },
      { tool: "context_search", args: { query: "c" } },
    ]);
    expect(res).toHaveLength(3);
    for (const r of res) expect(r.ok).toBe(true);
    expect(callToolMock).toHaveBeenCalledTimes(3);
  });

  it("batchReads returns per-op timeout error without failing the others", async () => {
    vi.useFakeTimers();
    callToolMock.mockImplementation((req: { name: string }) => {
      if (req.name === "slow") {
        // never resolves
        return new Promise(() => {});
      }
      return Promise.resolve(okResult({ ok: true }));
    });
    const { brain } = await import("@/clients/brain");
    const p = brain.batchReads([
      { tool: "slow", args: {} },
      { tool: "memory_search", args: {} },
    ]);
    // advance past the 5s timeout
    await vi.advanceTimersByTimeAsync(6000);
    const res = await p;
    vi.useRealTimers();
    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({ ok: false, error: "timeout" });
    expect(res[1]?.ok).toBe(true);
  });

  it("batchReads surfaces MCP errors on a single op without breaking the rest", async () => {
    callToolMock.mockImplementation((req: { name: string }) => {
      if (req.name === "memory_search") {
        return Promise.reject(new Error("brainctl exploded"));
      }
      return Promise.resolve(okResult({ ok: true }));
    });
    const { brain } = await import("@/clients/brain");
    const res = await brain.batchReads([
      { tool: "memory_search", args: {} },
      { tool: "entity_search", args: {} },
      { tool: "context_search", args: {} },
    ]);
    expect(res[0]).toEqual({ ok: false, error: "brainctl exploded" });
    expect(res[1]?.ok).toBe(true);
    expect(res[2]?.ok).toBe(true);
  });

  it("batchReads on empty input returns empty array without calling MCP", async () => {
    callToolMock.mockResolvedValue(okResult({}));
    const { brain } = await import("@/clients/brain");
    const res = await brain.batchReads([]);
    expect(res).toEqual([]);
    expect(callToolMock).not.toHaveBeenCalled();
  });
});
