import { createBudget } from "@/agent/budget";
import type { SpawnSpec } from "@/cockpit/core/subagents";
import { CliProcessBackend, resolveArgs } from "@/cockpit/subagents/cli-process";
import { describe, expect, it } from "vitest";

// ─── resolveArgs (hard constraint #7) ───────────────────────────────────────

describe("resolveArgs — Claude Code --bare flag", () => {
  const baseSpec: SpawnSpec = {
    task: "test task",
    backend: "cli-process",
    parentSessionId: "sess-1",
    cmd: "claude",
    args: ["-p", "--output-format", "stream-json"],
  };

  it("adds --bare in api_key mode when not already present", () => {
    const args = resolveArgs(baseSpec, "api_key");
    expect(args).toContain("--bare");
    expect(args[0]).toBe("--bare");
  });

  it("does not duplicate --bare in api_key mode when already present", () => {
    const spec = { ...baseSpec, args: ["--bare", "-p"] };
    const args = resolveArgs(spec, "api_key");
    const bareCount = args.filter((a) => a === "--bare").length;
    expect(bareCount).toBe(1);
  });

  it("never passes --bare in oauth_external mode", () => {
    const args = resolveArgs(baseSpec, "oauth_external");
    expect(args).not.toContain("--bare");
  });

  it("strips --bare from args in oauth_external mode even if explicitly provided", () => {
    const spec = { ...baseSpec, args: ["--bare", "-p", "--output-format", "stream-json"] };
    const args = resolveArgs(spec, "oauth_external");
    expect(args).not.toContain("--bare");
  });

  it("does not add --bare in oauth_device_code mode", () => {
    const args = resolveArgs(baseSpec, "oauth_device_code");
    expect(args).not.toContain("--bare");
  });

  it("does not modify args for non-claude commands", () => {
    const spec = { ...baseSpec, cmd: "codex", args: ["exec", "--json"] };
    const args = resolveArgs(spec, "api_key");
    expect(args).toEqual(["exec", "--json"]);
    expect(args).not.toContain("--bare");
  });

  it("handles missing args gracefully", () => {
    const { args: _discard, ...rest } = baseSpec;
    const spec: SpawnSpec = { ...rest };
    const args = resolveArgs(spec, "api_key");
    expect(args).toEqual(["--bare"]);
  });
});

// ─── CliProcessBackend depth + concurrency ──────────────────────────────────

describe("CliProcessBackend", () => {
  it("rejects spawn when depth exceeds MAX_SUBAGENT_DEPTH", async () => {
    const backend = new CliProcessBackend({
      parentBudget: createBudget({
        tokens: 10000,
        usdTicks: 1000000,
        wallClockMs: 60000,
        toolCalls: 10,
      }),
    });
    const spec: SpawnSpec = {
      task: "deep task",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "echo",
      args: ["hello"],
      depth: 4,
    };
    await expect(backend.spawn(spec)).rejects.toThrow("depth 4 exceeds maximum 3");
  });

  it("rejects spawn at max depth boundary", async () => {
    const backend = new CliProcessBackend({
      parentBudget: createBudget({
        tokens: 10000,
        usdTicks: 1000000,
        wallClockMs: 60000,
        toolCalls: 10,
      }),
    });
    const spec: SpawnSpec = {
      task: "deep task",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "echo",
      args: ["hello"],
      depth: 4,
    };
    await expect(backend.spawn(spec)).rejects.toThrow("depth");
  });

  it("allows spawn at exactly max depth", async () => {
    const backend = new CliProcessBackend({
      parentBudget: createBudget({
        tokens: 10000,
        usdTicks: 1000000,
        wallClockMs: 60000,
        toolCalls: 10,
      }),
    });
    const spec: SpawnSpec = {
      task: "hello",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "echo",
      args: ["hello"],
      depth: 3,
    };
    const handle = await backend.spawn(spec);
    // Clean up
    await handle.cancel();
  });

  it("rejects spawn when concurrency limit reached", async () => {
    const backend = new CliProcessBackend({
      maxConcurrentChildren: 1,
      parentBudget: createBudget({
        tokens: 100000,
        usdTicks: 10000000,
        wallClockMs: 600000,
        toolCalls: 100,
      }),
    });
    const spec: SpawnSpec = {
      task: "hello",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "sleep",
      args: ["10"],
      depth: 0,
    };
    const handle = await backend.spawn(spec);
    await expect(backend.spawn(spec)).rejects.toThrow("Concurrent children limit");
    await handle.cancel();
  });

  it("rejects interactive mode (not yet implemented)", async () => {
    const backend = new CliProcessBackend({
      parentBudget: createBudget({
        tokens: 10000,
        usdTicks: 1000000,
        wallClockMs: 60000,
        toolCalls: 10,
      }),
    });
    const spec: SpawnSpec = {
      task: "interactive task",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "bash",
      mode: "interactive",
    };
    await expect(backend.spawn(spec)).rejects.toThrow("Interactive mode not yet implemented");
  });

  it("rejects spawn without cmd", async () => {
    const backend = new CliProcessBackend({
      parentBudget: createBudget({
        tokens: 10000,
        usdTicks: 1000000,
        wallClockMs: 60000,
        toolCalls: 10,
      }),
    });
    const spec: SpawnSpec = {
      task: "no cmd",
      backend: "cli-process",
      parentSessionId: "sess-1",
    };
    await expect(backend.spawn(spec)).rejects.toThrow("SpawnSpec.cmd is required");
  });

  it("spawns a process and receives events", async () => {
    const backend = new CliProcessBackend({
      parentBudget: createBudget({
        tokens: 10000,
        usdTicks: 1000000,
        wallClockMs: 60000,
        toolCalls: 10,
      }),
    });
    const spec: SpawnSpec = {
      task: "",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "echo",
      args: ["test output"],
      depth: 0,
      parser: "raw-text",
    };
    const handle = await backend.spawn(spec);
    const events = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    // Should have spawn + stdout + end events
    expect(events.some((e) => e.t === "subagent.spawn")).toBe(true);
    expect(events.some((e) => e.t === "subagent.event")).toBe(true);
    expect(events.some((e) => e.t === "subagent.end")).toBe(true);
    const endEvent = events.find((e) => e.t === "subagent.end");
    expect(endEvent).toBeDefined();
    if (endEvent && endEvent.t === "subagent.end") {
      expect(endEvent.ok).toBe(true);
      expect(endEvent.exit).toBe(0);
    }
  });

  it("reports status after completion", async () => {
    const backend = new CliProcessBackend({
      parentBudget: createBudget({
        tokens: 10000,
        usdTicks: 1000000,
        wallClockMs: 60000,
        toolCalls: 10,
      }),
    });
    const spec: SpawnSpec = {
      task: "",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "echo",
      args: ["done"],
      depth: 0,
      parser: "raw-text",
    };
    const handle = await backend.spawn(spec);
    // Drain events
    for await (const _ of handle.events) {
      /* consume */
    }
    const status = await handle.status();
    expect(status.state).toBe("completed");
    expect(status.exit).toBe(0);
    expect(status.startedAt).toBeDefined();
    expect(status.endedAt).toBeDefined();
  });

  it("frees concurrency slot after child completes", async () => {
    const backend = new CliProcessBackend({
      maxConcurrentChildren: 1,
      parentBudget: createBudget({
        tokens: 100000,
        usdTicks: 10000000,
        wallClockMs: 600000,
        toolCalls: 100,
      }),
    });
    const spec: SpawnSpec = {
      task: "",
      backend: "cli-process",
      parentSessionId: "sess-1",
      cmd: "echo",
      args: ["fast"],
      depth: 0,
      parser: "raw-text",
    };
    const handle1 = await backend.spawn(spec);
    for await (const _ of handle1.events) {
      /* consume */
    }
    // Slot is freed, second spawn should succeed
    const handle2 = await backend.spawn(spec);
    for await (const _ of handle2.events) {
      /* consume */
    }
    expect(backend.activeCount()).toBe(0);
  });
});
