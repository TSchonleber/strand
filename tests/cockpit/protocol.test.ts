import { createBudget } from "@/agent/budget";
import {
  COCKPIT_PROTOCOL_HEADER,
  COCKPIT_PROTOCOL_VERSION,
  CockpitEventSchema,
  DEFAULT_COCKPIT_BUDGET_LIMITS,
  EventBus,
  defaultChildBudgetLimits,
} from "@/cockpit/core";
import { COCKPIT_SSE_HEADERS, WEB_COCKPIT_RENDERER } from "@/cockpit/web";
import { describe, expect, it } from "vitest";

describe("cockpit protocol scaffold", () => {
  it("pins protocol version 1 for renderers", () => {
    expect(COCKPIT_PROTOCOL_VERSION).toBe(1);
    expect(COCKPIT_SSE_HEADERS[COCKPIT_PROTOCOL_HEADER]).toBe("1");
    expect(WEB_COCKPIT_RENDERER.protocolVersion).toBe(1);
  });

  it("parses the pinned transcript event schema", () => {
    const event = CockpitEventSchema.parse({
      t: "transcript.append",
      sessionId: "session-1",
      message: {
        id: "message-1",
        role: "user",
        content: "ship the cockpit scaffold",
        createdAt: "2026-04-24T12:00:00.000Z",
      },
    });

    expect(event.t).toBe("transcript.append");
    if (event.t !== "transcript.append") throw new Error("expected transcript append event");
    expect(event.message.content).toBe("ship the cockpit scaffold");
  });

  it("emits typed events through the in-process bus", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.t));

    bus.publish({
      t: "budget.warn",
      sessionId: "session-1",
      dimension: "tokens",
      used: 45_000,
      cap: 50_000,
    });
    unsubscribe();

    expect(seen).toEqual(["budget.warn"]);
  });

  it("defaults to lean cockpit session budgets and half-budget children", () => {
    expect(DEFAULT_COCKPIT_BUDGET_LIMITS).toEqual({
      tokens: 50_000,
      usdTicks: 2_000_000,
      wallClockMs: 300_000,
      toolCalls: 40,
    });

    const parent = createBudget(DEFAULT_COCKPIT_BUDGET_LIMITS);
    const child = defaultChildBudgetLimits(parent);
    expect(child.tokens).toBe(25_000);
    expect(child.usdTicks).toBe(1_000_000);
    expect(child.toolCalls).toBe(20);
    expect(child.wallClockMs).toBeLessThanOrEqual(150_000);
    expect(child.wallClockMs).toBeGreaterThan(149_000);
  });
});
