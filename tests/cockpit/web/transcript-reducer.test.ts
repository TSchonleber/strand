import type { CockpitEvent } from "@/cockpit/core/events";
import {
  initialTranscriptState,
  reduceTranscriptEvent,
  replayEvents,
} from "@/cockpit/web/transcript-reducer";
import { describe, expect, it } from "vitest";

// ── Helpers ─────────────────────────────────────────────────────────────────

function msg(
  id: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
): CockpitEvent {
  return {
    t: "transcript.append",
    sessionId: "s1",
    message: { id, role, content },
  };
}

function delta(messageId: string, chunk: string): CockpitEvent {
  return { t: "transcript.delta", sessionId: "s1", messageId, chunk };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("transcript reducer — parity-oriented", () => {
  it("starts with empty state", () => {
    const state = initialTranscriptState();
    expect(state.messages).toEqual([]);
    expect(state.toolCalls.size).toBe(0);
    expect(state.subagents.size).toBe(0);
    expect(state.skillProposals.size).toBe(0);
    expect(state.activeProvider).toBeNull();
    expect(state.budgetWarnings).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.policyEvents).toEqual([]);
  });

  it("appends transcript messages in order", () => {
    const events: CockpitEvent[] = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi there"),
      msg("m3", "system", "context loaded"),
    ];
    const state = replayEvents(events);
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0]?.id).toBe("m1");
    expect(state.messages[0]?.role).toBe("user");
    expect(state.messages[0]?.content).toBe("hello");
    expect(state.messages[1]?.role).toBe("assistant");
    expect(state.messages[2]?.role).toBe("system");
  });

  it("applies streaming deltas to the correct message", () => {
    const events: CockpitEvent[] = [
      msg("m1", "assistant", ""),
      delta("m1", "Hello"),
      delta("m1", " world"),
    ];
    const state = replayEvents(events);
    expect(state.messages[0]?.content).toBe("Hello world");
    expect(state.messages[0]?.streaming).toBe(true);
  });

  it("ignores deltas for unknown message IDs", () => {
    const events: CockpitEvent[] = [msg("m1", "user", "hi"), delta("m-unknown", "ghost")];
    const state = replayEvents(events);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("hi");
  });

  it("tracks tool call lifecycle: start → progress → end", () => {
    const events: CockpitEvent[] = [
      {
        t: "tool.start",
        sessionId: "s1",
        callId: "c1",
        name: "web_search",
        args: { query: "test" },
      },
      { t: "tool.progress", sessionId: "s1", callId: "c1", chunk: "searching..." },
      {
        t: "tool.end",
        sessionId: "s1",
        callId: "c1",
        ok: true,
        result: { items: [] },
      },
    ];
    const state = replayEvents(events);
    const tc = state.toolCalls.get("c1");
    expect(tc).toBeDefined();
    expect(tc?.name).toBe("web_search");
    expect(tc?.progress).toBe("searching...");
    expect(tc?.ok).toBe(true);
  });

  it("tracks subagent lifecycle: spawn → event → end", () => {
    const events: CockpitEvent[] = [
      {
        t: "subagent.spawn",
        subagentId: "sa1",
        backend: "cli-process",
        parentSessionId: "s1",
      },
      {
        t: "subagent.event",
        subagentId: "sa1",
        kind: "stdout",
        chunk: "output line 1\n",
      },
      {
        t: "subagent.event",
        subagentId: "sa1",
        kind: "stdout",
        chunk: "output line 2\n",
      },
      { t: "subagent.end", subagentId: "sa1", ok: true, exit: 0 },
    ];
    const state = replayEvents(events);
    const sa = state.subagents.get("sa1");
    expect(sa).toBeDefined();
    expect(sa?.backend).toBe("cli-process");
    expect(sa?.output).toBe("output line 1\noutput line 2\n");
    expect(sa?.status).toBe("completed");
    expect(sa?.exit).toBe(0);
  });

  it("records failed subagent with exit code", () => {
    const events: CockpitEvent[] = [
      {
        t: "subagent.spawn",
        subagentId: "sa2",
        backend: "internal",
        parentSessionId: "s1",
      },
      { t: "subagent.end", subagentId: "sa2", ok: false, exit: 1 },
    ];
    const state = replayEvents(events);
    const sa = state.subagents.get("sa2");
    expect(sa?.status).toBe("failed");
    expect(sa?.exit).toBe(1);
  });

  it("tracks skill proposal and decision", () => {
    const events: CockpitEvent[] = [
      {
        t: "skill.proposal",
        proposalId: "p1",
        kind: "draft",
        payload: { rationale: "useful pattern detected" },
      },
      {
        t: "skill.decision",
        proposalId: "p1",
        decision: "accepted",
        by: "user",
      },
    ];
    const state = replayEvents(events);
    const proposal = state.skillProposals.get("p1");
    expect(proposal).toBeDefined();
    expect(proposal?.kind).toBe("draft");
    expect(proposal?.decision).toBe("accepted");
    expect(proposal?.decidedBy).toBe("user");
  });

  it("tracks provider switches", () => {
    const events: CockpitEvent[] = [
      { t: "provider.switch", from: "xai", to: "anthropic" },
      { t: "provider.switch", from: "anthropic", to: "openai" },
    ];
    const state = replayEvents(events);
    expect(state.activeProvider).toBe("openai");
  });

  it("accumulates budget warnings", () => {
    const events: CockpitEvent[] = [
      {
        t: "budget.warn",
        sessionId: "s1",
        dimension: "tokens",
        used: 45000,
        cap: 50000,
      },
      {
        t: "budget.warn",
        sessionId: "s1",
        dimension: "usd",
        used: 1800000,
        cap: 2000000,
      },
    ];
    const state = replayEvents(events);
    expect(state.budgetWarnings).toHaveLength(2);
    expect(state.budgetWarnings[0]?.dimension).toBe("tokens");
    expect(state.budgetWarnings[1]?.dimension).toBe("usd");
  });

  it("accumulates errors", () => {
    const events: CockpitEvent[] = [
      {
        t: "error",
        sessionId: "s1",
        code: "RATE_LIMIT",
        message: "429 from X API",
      },
      {
        t: "error",
        code: "PARSE_ERROR",
        message: "malformed response",
      },
    ];
    const state = replayEvents(events);
    expect(state.errors).toHaveLength(2);
    expect(state.errors[0]?.code).toBe("RATE_LIMIT");
    expect(state.errors[1]?.sessionId).toBeUndefined();
  });

  it("accumulates policy gate events", () => {
    const events: CockpitEvent[] = [
      {
        t: "policy.gate",
        candidateId: "cand-1",
        result: "approved",
      },
      {
        t: "policy.gate",
        candidateId: "cand-2",
        result: "rejected",
        reason: "relevance below threshold",
      },
    ];
    const state = replayEvents(events);
    expect(state.policyEvents).toHaveLength(2);
    expect(state.policyEvents[0]?.result).toBe("approved");
    expect(state.policyEvents[1]?.reason).toBe("relevance below threshold");
  });

  it("replays a complete scripted session", () => {
    const events: CockpitEvent[] = [
      msg("m1", "system", "Welcome to Strand cockpit."),
      msg("m2", "user", "scout trending AI topics"),
      msg("m3", "assistant", ""),
      delta("m3", "Let me search"),
      delta("m3", " for that..."),
      {
        t: "tool.start",
        sessionId: "s1",
        callId: "tc1",
        name: "x_search",
        args: { query: "AI trends" },
      },
      {
        t: "tool.end",
        sessionId: "s1",
        callId: "tc1",
        ok: true,
        result: { tweets: [] },
      },
      {
        t: "subagent.spawn",
        subagentId: "sub1",
        backend: "cli-process",
        parentSessionId: "s1",
      },
      {
        t: "subagent.event",
        subagentId: "sub1",
        kind: "stdout",
        chunk: "analysis complete",
      },
      { t: "subagent.end", subagentId: "sub1", ok: true, exit: 0 },
      {
        t: "budget.warn",
        sessionId: "s1",
        dimension: "tokens",
        used: 40000,
        cap: 50000,
      },
      msg("m4", "assistant", "Found 3 trending topics."),
    ];

    const state = replayEvents(events);

    expect(state.messages).toHaveLength(4);
    expect(state.messages[2]?.content).toBe("Let me search for that...");
    expect(state.messages[2]?.streaming).toBe(true);
    expect(state.messages[3]?.content).toBe("Found 3 trending topics.");

    expect(state.toolCalls.get("tc1")?.ok).toBe(true);
    expect(state.subagents.get("sub1")?.status).toBe("completed");
    expect(state.budgetWarnings).toHaveLength(1);
  });

  it("reducer is pure — does not mutate input state", () => {
    const state = initialTranscriptState();
    const event: CockpitEvent = msg("m1", "user", "test");
    const next = reduceTranscriptEvent(state, event);

    expect(state.messages).toHaveLength(0);
    expect(next.messages).toHaveLength(1);
    expect(state).not.toBe(next);
  });
});
