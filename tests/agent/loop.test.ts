import { NoopExecutor, runAgenticLoop } from "@/agent";
import type { LocalTool } from "@/agent";
import type { LlmCall, LlmCapabilities, LlmProvider, LlmResult, LlmUsage } from "@/clients/llm";
import type { LlmToolCall } from "@/clients/llm/types";
import { describe, expect, it, vi } from "vitest";

/**
 * Agentic loop unit tests. The provider is a `vi.fn()` that returns a
 * queue of canned LlmResults, one per iteration. Tests assert on the
 * transcript, trace, stop reason, summed usage, and tool dispatch.
 */

const DEFAULT_CAPS: LlmCapabilities = {
  structuredOutput: true,
  mcp: false,
  serverSideTools: [],
  batch: false,
  promptCacheKey: false,
  previousResponseId: false,
  functionToolLoop: true,
  computerUse: true,
  maxContextTokens: 128_000,
};

function makeUsage(input = 10, cached = 0, output = 5, reasoning = 0, ticks = 100): LlmUsage {
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: reasoning,
    costInUsdTicks: ticks,
  };
}

function makeResult(overrides: Partial<LlmResult> = {}): LlmResult {
  return {
    outputText: "",
    parsed: null,
    responseId: "resp-1",
    systemFingerprint: null,
    usage: makeUsage(),
    toolCalls: [],
    rawResponse: {},
    ...overrides,
  };
}

function makeProvider(results: LlmResult[]): {
  provider: LlmProvider;
  chat: ReturnType<typeof vi.fn>;
} {
  const queue = [...results];
  const chat = vi.fn(async (_input: LlmCall): Promise<LlmResult> => {
    const next = queue.shift();
    if (!next) throw new Error("provider chat queue exhausted");
    return next;
  });
  const provider: LlmProvider = {
    name: "mock",
    capabilities: DEFAULT_CAPS,
    chat: chat as unknown as LlmProvider["chat"],
  };
  return { provider, chat };
}

function makeTool<A = unknown, R = unknown>(
  overrides: Partial<LocalTool<A, R>> & Pick<LocalTool<A, R>, "name" | "execute">,
): LocalTool<A, R> {
  return {
    description: overrides.description ?? `tool ${overrides.name}`,
    parameters: overrides.parameters ?? { type: "object", properties: {} },
    ...overrides,
  };
}

describe("runAgenticLoop", () => {
  it("no-tool path: exits after one iteration with text_complete", async () => {
    const { provider, chat } = makeProvider([
      makeResult({ outputText: "done", responseId: "r1", usage: makeUsage(3, 0, 2) }),
    ]);

    const out = await runAgenticLoop({
      provider,
      model: "mock-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(out.iterations).toBe(1);
    expect(out.stopReason).toBe("text_complete");
    expect(out.finalText).toBe("done");
    expect(out.finalResponseId).toBe("r1");
    expect(out.toolCallsTotal).toBe(0);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(out.trace.some((t) => t.event === "chat_call")).toBe(true);
    expect(out.trace.some((t) => t.event === "stop")).toBe(true);
  });

  it("single local-tool round trip: provider → tool → provider → text", async () => {
    const calls: LlmToolCall[] = [{ id: "c1", name: "echo", args: { msg: "hello" } }];
    const { provider } = makeProvider([
      makeResult({ outputText: "", responseId: "r1", toolCalls: calls }),
      makeResult({ outputText: "final", responseId: "r2" }),
    ]);

    const execute = vi.fn(async (args: { msg: string }) => ({ echoed: args.msg }));
    const tool = makeTool<{ msg: string }, { echoed: string }>({
      name: "echo",
      execute,
    });

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
      localTools: [tool],
    });

    expect(out.iterations).toBe(2);
    expect(out.stopReason).toBe("text_complete");
    expect(out.finalText).toBe("final");
    expect(out.toolCallsTotal).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);

    // transcript: [user, assistant(toolCalls), tool, assistant_final?]
    // The final assistant message isn't appended by the loop — callers get
    // finalText/finalResponseId. Check the tool-message plumbing.
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCallId).toBe("c1");
    expect(toolMsg?.content).toContain("echoed");
  });

  it("multiple tool calls in one iteration dispatched in parallel", async () => {
    const toolCalls: LlmToolCall[] = [
      { id: "a", name: "alpha", args: {} },
      { id: "b", name: "beta", args: {} },
    ];
    const { provider } = makeProvider([
      makeResult({ toolCalls }),
      makeResult({ outputText: "ok" }),
    ]);

    const order: string[] = [];
    const alpha = makeTool({
      name: "alpha",
      execute: async () => {
        order.push("alpha-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("alpha-end");
        return "a";
      },
    });
    const beta = makeTool({
      name: "beta",
      execute: async () => {
        order.push("beta-start");
        await new Promise((r) => setTimeout(r, 5));
        order.push("beta-end");
        return "b";
      },
    });

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
      localTools: [alpha, beta],
    });

    expect(out.toolCallsTotal).toBe(2);
    // Parallel: both starts happen before either end.
    expect(order.indexOf("alpha-start")).toBeLessThan(order.indexOf("beta-end"));
    expect(order.indexOf("beta-start")).toBeLessThan(order.indexOf("alpha-end"));
    // Both tool messages present.
    expect(out.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("max iterations cap: stops with stopReason=max_iterations", async () => {
    const results: LlmResult[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        makeResult({
          responseId: `r${i}`,
          toolCalls: [{ id: `c${i}`, name: "loopy", args: {} }],
        }),
      );
    }
    const { provider, chat } = makeProvider(results);
    const tool = makeTool({ name: "loopy", execute: async () => "again" });

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
      localTools: [tool],
      maxIterations: 3,
    });

    expect(out.iterations).toBe(3);
    expect(out.stopReason).toBe("max_iterations");
    expect(chat).toHaveBeenCalledTimes(3);
    expect(out.toolCallsTotal).toBe(3);
  });

  it("unknown tool name: recorded as error result, loop continues", async () => {
    const { provider } = makeProvider([
      makeResult({ toolCalls: [{ id: "x1", name: "nope", args: {} }] }),
      makeResult({ outputText: "recovered" }),
    ]);

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
    });

    expect(out.stopReason).toBe("text_complete");
    expect(out.finalText).toBe("recovered");
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("unknown_tool:nope");
  });

  it("local-tool gate rejects: error recorded, loop continues", async () => {
    const { provider } = makeProvider([
      makeResult({ toolCalls: [{ id: "g1", name: "gated", args: {} }] }),
      makeResult({ outputText: "continued" }),
    ]);

    const tool = makeTool({
      name: "gated",
      execute: async () => "should not reach",
      gate: () => {
        throw new Error("policy: rejected");
      },
    });

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
      localTools: [tool],
    });

    expect(out.finalText).toBe("continued");
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("policy: rejected");
  });

  it("computer-use dispatch: left_click routed to executor.click", async () => {
    const { provider } = makeProvider([
      makeResult({
        toolCalls: [
          {
            id: "cu1",
            name: "computer",
            args: { action: "left_click", coordinate: [100, 200] },
          },
        ],
      }),
      makeResult({ outputText: "clicked" }),
    ]);

    const executor = new NoopExecutor();
    const clickSpy = vi.spyOn(executor, "click");

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "click" }],
      executor,
    });

    expect(clickSpy).toHaveBeenCalledWith(100, 200, "left");
    expect(out.finalText).toBe("clicked");
    expect(out.toolCallsTotal).toBe(1);
  });

  it("abort signal: stops mid-loop with stopReason=abort", async () => {
    const controller = new AbortController();
    const { provider } = makeProvider([
      makeResult({ toolCalls: [{ id: "t1", name: "trip", args: {} }] }),
      makeResult({ outputText: "never-reached" }),
    ]);

    const tool = makeTool({
      name: "trip",
      execute: async () => {
        controller.abort();
        return "aborted-during-exec";
      },
    });

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
      localTools: [tool],
      signal: controller.signal,
    });

    expect(out.stopReason).toBe("abort");
    expect(out.iterations).toBe(1);
    expect(out.trace.some((t) => t.event === "abort")).toBe(true);
  });

  it("usage summed across iterations", async () => {
    const { provider } = makeProvider([
      makeResult({
        toolCalls: [{ id: "u1", name: "sum", args: {} }],
        usage: makeUsage(10, 2, 3, 1, 50),
      }),
      makeResult({
        outputText: "done",
        usage: makeUsage(20, 8, 4, 2, 75),
      }),
    ]);

    const tool = makeTool({ name: "sum", execute: async () => "k" });

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
      localTools: [tool],
    });

    expect(out.usage.inputTokens).toBe(30);
    expect(out.usage.cachedInputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(7);
    expect(out.usage.reasoningTokens).toBe(3);
    expect(out.usage.costInUsdTicks).toBe(125);
  });

  it("provider error: stopReason=error, returns partial", async () => {
    const provider: LlmProvider = {
      name: "mock",
      capabilities: DEFAULT_CAPS,
      chat: vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as LlmProvider["chat"],
    };

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
    });

    expect(out.stopReason).toBe("error");
    expect(out.iterations).toBe(0);
    expect(out.trace.some((t) => t.event === "error")).toBe(true);
  });

  it("tool-call id synthesized when missing", async () => {
    const { provider } = makeProvider([
      makeResult({ toolCalls: [{ name: "noid", args: {} }] }),
      makeResult({ outputText: "ok" }),
    ]);

    const tool = makeTool({ name: "noid", execute: async () => "v" });

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "go" }],
      localTools: [tool],
    });

    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("fc-1-0");
  });

  it("computer-use without executor throws error into tool result", async () => {
    const { provider } = makeProvider([
      makeResult({
        toolCalls: [{ id: "c1", name: "computer", args: { action: "screenshot" } }],
      }),
      makeResult({ outputText: "recovered" }),
    ]);

    const out = await runAgenticLoop({
      provider,
      model: "m",
      messages: [{ role: "user", content: "screenshot" }],
    });

    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("no executor");
    expect(out.finalText).toBe("recovered");
  });
});
