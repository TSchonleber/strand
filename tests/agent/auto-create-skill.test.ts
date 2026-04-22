import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultToolRegistry,
  type PlanRunResult,
  type SkillProposal,
  type SkillProposalStore,
  type Tool,
  autoCreateSkill,
} from "@/agent";
import type { LlmCall, LlmProvider, LlmResult, LlmUsage } from "@/clients/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costInUsdTicks: 0,
};

function stubProvider(proposalJson: Record<string, unknown>): LlmProvider & { calls: LlmCall[] } {
  const calls: LlmCall[] = [];
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
      maxContextTokens: 200_000,
    },
    async chat<T>(input: LlmCall): Promise<LlmResult<T>> {
      calls.push(input);
      return {
        outputText: JSON.stringify(proposalJson),
        parsed: proposalJson as T,
        responseId: "prop_1",
        systemFingerprint: null,
        usage: { ...ZERO_USAGE, inputTokens: 300, outputTokens: 120 },
        toolCalls: [],
        rawResponse: {},
      };
    },
    calls,
  };
}

class MemoryStore implements SkillProposalStore {
  rows = new Map<string, SkillProposal>();
  async save(p: SkillProposal): Promise<void> {
    this.rows.set(p.id, { ...p });
  }
  async load(id: string): Promise<SkillProposal | null> {
    return this.rows.get(id) ?? null;
  }
  async listByStatus(status: SkillProposal["status"]): Promise<SkillProposal[]> {
    return [...this.rows.values()].filter((p) => p.status === status);
  }
  async updateStatus(
    id: string,
    status: SkillProposal["status"],
    decidedBy: "auto" | "human",
  ): Promise<void> {
    const p = this.rows.get(id);
    if (!p) return;
    p.status = status;
    p.decidedBy = decidedBy;
    p.decidedAt = new Date().toISOString();
  }
}

function makeCompletedPlan(overrides?: Partial<PlanRunResult>): PlanRunResult {
  return {
    graphId: "g1",
    rootGoal: "crawl site X and summarize",
    status: "completed",
    finalOutput: "[step 1] ok\n\n[step 2] ok",
    steps: [
      {
        id: "s1",
        parentId: null,
        goal: "fetch home page via http_fetch",
        allowedTools: ["http_fetch"],
        status: "completed",
        createdAt: "2026-04-22T10:00:00.000Z",
        updatedAt: "2026-04-22T10:00:05.000Z",
      },
      {
        id: "s2",
        parentId: null,
        goal: "summarize results",
        allowedTools: ["fs_write"],
        status: "completed",
        createdAt: "2026-04-22T10:00:05.000Z",
        updatedAt: "2026-04-22T10:00:10.000Z",
      },
    ],
    totalUsage: { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 400 },
    totalToolCalls: 3,
    durationMs: 5_000,
    stopReason: "completed",
    ...overrides,
  };
}

function makeRegistry(): DefaultToolRegistry {
  const registry = new DefaultToolRegistry();
  const registerTool = (name: string, sideEffects: NonNullable<Tool["sideEffects"]>): void => {
    registry.register({
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {}, required: [] },
      sideEffects,
      async execute() {
        return {};
      },
    });
  };
  registerTool("http_fetch", "external");
  registerTool("fs_read", "none");
  registerTool("fs_write", "local");
  return registry;
}

describe("autoCreateSkill — safety gates", () => {
  it("does nothing when mode=off", async () => {
    const provider = stubProvider({ worthCreating: true, reasoning: "ok" });
    const ctx = {
      provider,
      tools: makeRegistry(),
      budget: {
        check() {},
        consumeUsage() {},
        consumeToolCall() {},
        snapshot: () => ({
          spentUsdTicks: 0,
          spentTokens: 0,
          elapsedMs: 0,
          toolCalls: 0,
          limits: {},
        }),
        fork: () => ({}) as never,
      },
      depth: 0,
    };
    const r = await autoCreateSkill({
      ctx: ctx as never,
      plan: makeCompletedPlan(),
      opts: { mode: "off", store: new MemoryStore() },
    });
    expect(r.attempted).toBe(false);
    expect(r.skippedReason).toBe("mode=off");
    expect(provider.calls).toHaveLength(0);
  });

  it("skips when plan did not complete", async () => {
    const provider = stubProvider({ worthCreating: true, reasoning: "ok" });
    const store = new MemoryStore();
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan({ status: "failed", stopReason: "failed" }),
      opts: { mode: "manual", store },
    });
    expect(r.attempted).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it("skips when completed steps < minSteps", async () => {
    const provider = stubProvider({ worthCreating: true, reasoning: "ok" });
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan({ steps: [] }),
      opts: { mode: "manual", store: new MemoryStore() },
    });
    expect(r.attempted).toBe(false);
    expect(r.skippedReason).toContain("completedSteps");
  });

  it("skips when tool calls < minToolCalls", async () => {
    const provider = stubProvider({ worthCreating: true, reasoning: "ok" });
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan({ totalToolCalls: 0 }),
      opts: { mode: "manual", store: new MemoryStore() },
    });
    expect(r.attempted).toBe(false);
    expect(r.skippedReason).toContain("totalToolCalls");
  });
});

describe("autoCreateSkill — proposal flow", () => {
  it("queues a proposal under manual mode", async () => {
    const provider = stubProvider({
      worthCreating: true,
      reasoning: "procedure reusable against other URLs",
      skill: {
        name: "crawl-and-summarize",
        description: "Fetch a page and write a short summary",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
        allowedTools: ["http_fetch", "fs_write"],
        sideEffects: "local",
        requiresLive: false,
        body: "1. http_fetch {{url}}\n2. fs_write a summary\n",
      },
    });
    const store = new MemoryStore();
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan(),
      opts: { mode: "manual", store },
    });
    expect(r.attempted).toBe(true);
    expect(r.installed).toBe(false);
    expect(r.proposalId).toBeDefined();
    expect(store.rows.size).toBe(1);
    const [row] = [...store.rows.values()];
    expect(row?.status).toBe("pending");
    expect(row?.proposedName).toBe("crawl-and-summarize");
    // LLM call used the stable cache key
    expect(provider.calls[0]?.promptCacheKey).toBe("strand:skills:propose:v1");
  });

  it("declines when LLM says not worth creating", async () => {
    const provider = stubProvider({
      worthCreating: false,
      reasoning: "one-off task with hardcoded values",
    });
    const store = new MemoryStore();
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan(),
      opts: { mode: "manual", store },
    });
    expect(r.attempted).toBe(true);
    expect(r.installed).toBeUndefined();
    expect(r.reasoning).toContain("one-off");
    expect(store.rows.size).toBe(0);
  });

  it("rejects a name that shadows an existing tool", async () => {
    const provider = stubProvider({
      worthCreating: true,
      reasoning: "reusable",
      skill: {
        name: "fs_read", // collides with a registered built-in
        description: "Read a file",
        parameters: { type: "object", properties: {}, required: [] },
        body: "fs_read something",
      },
    });
    const store = new MemoryStore();
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan(),
      opts: { mode: "manual", store },
    });
    expect(r.attempted).toBe(true);
    expect(r.installed).toBeUndefined();
    expect(r.reasoning).toContain("shadow");
    expect(store.rows.size).toBe(0);
  });

  it("rejects a malformed name", async () => {
    const provider = stubProvider({
      worthCreating: true,
      reasoning: "reusable",
      skill: {
        name: "Has Spaces",
        description: "bad",
        parameters: { type: "object", properties: {}, required: [] },
        body: "x",
      },
    });
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan(),
      opts: { mode: "manual", store: new MemoryStore() },
    });
    expect(r.reasoning).toContain("invalid name");
  });
});

describe("autoCreateSkill — auto install", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "strand-autoskill-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("auto-installs a non-destructive skill (mode=auto)", async () => {
    const provider = stubProvider({
      worthCreating: true,
      reasoning: "clean",
      skill: {
        name: "auto-installed",
        description: "does a thing",
        parameters: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
        allowedTools: ["fs_read"],
        sideEffects: "none",
        requiresLive: false,
        body: "fs_read {{target}}\n",
      },
    });
    const store = new MemoryStore();
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan({
        steps: [
          {
            id: "s1",
            parentId: null,
            goal: "read config",
            allowedTools: ["fs_read"],
            status: "completed",
            createdAt: "2026-04-22T10:00:00.000Z",
            updatedAt: "2026-04-22T10:00:05.000Z",
          },
          {
            id: "s2",
            parentId: null,
            goal: "write summary",
            allowedTools: ["fs_write"],
            status: "completed",
            createdAt: "2026-04-22T10:00:05.000Z",
            updatedAt: "2026-04-22T10:00:10.000Z",
          },
        ],
      }),
      opts: { mode: "auto", store, projectSkillsDir: tmp },
    });
    expect(r.installed).toBe(true);
    const files = readdirSync(tmp);
    expect(files).toContain("auto-installed.skill.md");
    const body = readFileSync(join(tmp, "auto-installed.skill.md"), "utf8");
    expect(body).toContain("name: auto-installed");
    expect(body).toContain("{{target}}");

    const row = [...store.rows.values()][0];
    expect(row?.status).toBe("installed");
    expect(row?.decidedBy).toBe("auto");
  });

  it("never auto-installs destructive skills — queues instead", async () => {
    const provider = stubProvider({
      worthCreating: true,
      reasoning: "reusable but dangerous",
      skill: {
        name: "dangerous-op",
        description: "deletes stuff",
        parameters: { type: "object", properties: {}, required: [] },
        allowedTools: ["fs_write"],
        sideEffects: "destructive",
        requiresLive: true,
        body: "rm everything",
      },
    });
    const store = new MemoryStore();
    const r = await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan(),
      opts: { mode: "auto", store, projectSkillsDir: tmp },
    });
    expect(r.installed).toBe(false);
    expect(readdirSync(tmp)).toHaveLength(0);
    const row = [...store.rows.values()][0];
    expect(row?.status).toBe("pending");
  });

  it("escalates sideEffects to match observed plan tools", async () => {
    // Plan used http_fetch (external) but LLM proposed sideEffects="none".
    // The engine should correct it to "external".
    const provider = stubProvider({
      worthCreating: true,
      reasoning: "reusable",
      skill: {
        name: "escalated",
        description: "fetch thing",
        parameters: { type: "object", properties: {}, required: [] },
        allowedTools: ["http_fetch"],
        sideEffects: "none",
        requiresLive: false,
        body: "fetch",
      },
    });
    const store = new MemoryStore();
    await autoCreateSkill({
      ctx: { provider, tools: makeRegistry(), depth: 0 } as never,
      plan: makeCompletedPlan(),
      opts: { mode: "manual", store },
    });
    const row = [...store.rows.values()][0];
    expect(row?.proposedDoc.sideEffects).toBe("external");
  });
});
