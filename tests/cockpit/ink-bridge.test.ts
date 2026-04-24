import { type CockpitEvent, EventBus } from "@/cockpit/core/events";
import { createInkBridge, createSkillEventBridge } from "@/cockpit/ink/bridge";
import { describe, expect, it } from "vitest";

describe("InkBridge", () => {
  it("forwards events from the EventBus to handlers", () => {
    const bus = new EventBus();
    const bridge = createInkBridge({ bus });
    const seen: CockpitEvent[] = [];

    bridge.onEvent((e) => seen.push(e));

    bus.publish({
      t: "transcript.append",
      sessionId: "s1",
      message: { id: "m1", role: "user", content: "hello" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.t).toBe("transcript.append");
  });

  it("filters events by type when filter is provided", () => {
    const bus = new EventBus();
    const bridge = createInkBridge({ bus, filter: ["budget.warn"] });
    const seen: CockpitEvent[] = [];

    bridge.onEvent((e) => seen.push(e));

    bus.publish({
      t: "transcript.append",
      sessionId: "s1",
      message: { id: "m1", role: "user", content: "hello" },
    });
    bus.publish({
      t: "budget.warn",
      sessionId: "s1",
      dimension: "tokens",
      used: 45_000,
      cap: 50_000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.t).toBe("budget.warn");
  });

  it("stops forwarding after destroy()", () => {
    const bus = new EventBus();
    const bridge = createInkBridge({ bus });
    const seen: CockpitEvent[] = [];

    bridge.onEvent((e) => seen.push(e));
    expect(bridge.active).toBe(true);

    bridge.destroy();
    expect(bridge.active).toBe(false);

    bus.publish({
      t: "transcript.append",
      sessionId: "s1",
      message: { id: "m1", role: "user", content: "hello" },
    });

    expect(seen).toHaveLength(0);
  });

  it("does not register handlers after destroy", () => {
    const bus = new EventBus();
    const bridge = createInkBridge({ bus });
    bridge.destroy();

    const seen: CockpitEvent[] = [];
    bridge.onEvent((e) => seen.push(e));

    bus.publish({
      t: "budget.warn",
      sessionId: "s1",
      dimension: "tokens",
      used: 100,
      cap: 200,
    });

    expect(seen).toHaveLength(0);
  });
});

describe("createSkillEventBridge", () => {
  it("only passes skill.proposal and skill.decision events", () => {
    const bus = new EventBus();
    const bridge = createSkillEventBridge(bus);
    const seen: CockpitEvent[] = [];

    bridge.onEvent((e) => seen.push(e));

    bus.publish({
      t: "transcript.append",
      sessionId: "s1",
      message: { id: "m1", role: "user", content: "hello" },
    });
    bus.publish({
      t: "skill.proposal",
      proposalId: "sp1",
      kind: "retire",
      payload: { rationale: "low hit rate" },
    });
    bus.publish({
      t: "skill.decision",
      proposalId: "sp1",
      decision: "accepted",
      by: "user",
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.t).toBe("skill.proposal");
    expect(seen[1]?.t).toBe("skill.decision");

    bridge.destroy();
  });
});
