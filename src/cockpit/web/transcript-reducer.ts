/**
 * Renderer-agnostic transcript state machine.
 *
 * Takes a stream of CockpitEvents and produces a TranscriptState that both Ink
 * and Web renderers can consume. Pure functions only — no side effects, no I/O,
 * no UI imports.
 */

import type { CockpitEvent, SkillProposal, SubagentBackend } from "../core/events";

// ─── State types ────────────────────────────────────────────────────────────

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "system" | "user" | "assistant" | "tool";
  content: string;
  readonly name: string | undefined;
  readonly toolCallId: string | undefined;
  readonly createdAt: string | undefined;
  streaming: boolean;
}

export interface ToolCallEntry {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  progress: string;
  ok: boolean | null;
  result: unknown | undefined;
}

export interface SubagentEntry {
  readonly id: string;
  readonly backend: SubagentBackend;
  readonly parentSessionId: string;
  status: "running" | "completed" | "failed";
  output: string;
  exit: number | undefined;
}

export interface SkillProposalEntry {
  readonly proposalId: string;
  readonly kind: "draft" | "retire";
  readonly payload: SkillProposal;
  decision: "accepted" | "rejected" | undefined;
  decidedBy: "user" | "auto" | undefined;
}

export interface BudgetWarningEntry {
  readonly dimension: string;
  readonly used: number;
  readonly cap: number;
}

export interface ErrorEntry {
  readonly code: string;
  readonly message: string;
  readonly sessionId: string | undefined;
}

export interface PolicyGateEntry {
  readonly candidateId: string;
  readonly result: "approved" | "rejected";
  readonly reason: string | undefined;
}

export interface TranscriptState {
  readonly messages: readonly TranscriptMessage[];
  readonly toolCalls: ReadonlyMap<string, ToolCallEntry>;
  readonly subagents: ReadonlyMap<string, SubagentEntry>;
  readonly skillProposals: ReadonlyMap<string, SkillProposalEntry>;
  readonly activeProvider: string | null;
  readonly budgetWarnings: readonly BudgetWarningEntry[];
  readonly errors: readonly ErrorEntry[];
  readonly policyEvents: readonly PolicyGateEntry[];
}

// ─── Initial state ──────────────────────────────────────────────────────────

export function initialTranscriptState(): TranscriptState {
  return {
    messages: [],
    toolCalls: new Map(),
    subagents: new Map(),
    skillProposals: new Map(),
    activeProvider: null,
    budgetWarnings: [],
    errors: [],
    policyEvents: [],
  };
}

// ─── Reducer ────────────────────────────────────────────────────────────────

export function reduceTranscriptEvent(
  state: TranscriptState,
  event: CockpitEvent,
): TranscriptState {
  switch (event.t) {
    case "transcript.append": {
      const m = event.message;
      const entry: TranscriptMessage = {
        id: m.id,
        role: m.role,
        content: m.content,
        name: m.name ?? undefined,
        toolCallId: m.toolCallId ?? undefined,
        createdAt: m.createdAt ?? undefined,
        streaming: false,
      };
      return { ...state, messages: [...state.messages, entry] };
    }

    case "transcript.delta": {
      const messages = state.messages.map((msg) =>
        msg.id === event.messageId
          ? { ...msg, content: msg.content + event.chunk, streaming: true }
          : msg,
      );
      return { ...state, messages };
    }

    case "tool.start": {
      const toolCalls = new Map(state.toolCalls);
      toolCalls.set(event.callId, {
        callId: event.callId,
        name: event.name,
        args: event.args,
        progress: "",
        ok: null,
        result: undefined,
      });
      return { ...state, toolCalls };
    }

    case "tool.progress": {
      const toolCalls = new Map(state.toolCalls);
      const prev = toolCalls.get(event.callId);
      if (prev) {
        toolCalls.set(event.callId, {
          ...prev,
          progress: prev.progress + event.chunk,
        });
      }
      return { ...state, toolCalls };
    }

    case "tool.end": {
      const toolCalls = new Map(state.toolCalls);
      const prev = toolCalls.get(event.callId);
      if (prev) {
        toolCalls.set(event.callId, {
          ...prev,
          ok: event.ok,
          result: event.result,
        });
      }
      return { ...state, toolCalls };
    }

    case "subagent.spawn": {
      const subagents = new Map(state.subagents);
      subagents.set(event.subagentId, {
        id: event.subagentId,
        backend: event.backend,
        parentSessionId: event.parentSessionId,
        status: "running",
        output: "",
        exit: undefined,
      });
      return { ...state, subagents };
    }

    case "subagent.event": {
      const subagents = new Map(state.subagents);
      const prev = subagents.get(event.subagentId);
      if (prev) {
        subagents.set(event.subagentId, {
          ...prev,
          output: prev.output + event.chunk,
        });
      }
      return { ...state, subagents };
    }

    case "subagent.end": {
      const subagents = new Map(state.subagents);
      const prev = subagents.get(event.subagentId);
      if (prev) {
        subagents.set(event.subagentId, {
          ...prev,
          status: event.ok ? "completed" : "failed",
          exit: event.exit,
        });
      }
      return { ...state, subagents };
    }

    case "skill.proposal": {
      const skillProposals = new Map(state.skillProposals);
      skillProposals.set(event.proposalId, {
        proposalId: event.proposalId,
        kind: event.kind,
        payload: event.payload,
        decision: undefined,
        decidedBy: undefined,
      });
      return { ...state, skillProposals };
    }

    case "skill.decision": {
      const skillProposals = new Map(state.skillProposals);
      const prev = skillProposals.get(event.proposalId);
      if (prev) {
        skillProposals.set(event.proposalId, {
          ...prev,
          decision: event.decision,
          decidedBy: event.by,
        });
      }
      return { ...state, skillProposals };
    }

    case "provider.switch":
      return { ...state, activeProvider: event.to };

    case "policy.gate":
      return {
        ...state,
        policyEvents: [
          ...state.policyEvents,
          {
            candidateId: event.candidateId,
            result: event.result,
            reason: event.reason,
          },
        ],
      };

    case "budget.warn":
      return {
        ...state,
        budgetWarnings: [
          ...state.budgetWarnings,
          {
            dimension: event.dimension,
            used: event.used,
            cap: event.cap,
          },
        ],
      };

    case "error":
      return {
        ...state,
        errors: [
          ...state.errors,
          {
            code: event.code,
            message: event.message,
            sessionId: event.sessionId,
          },
        ],
      };
  }
}

// ─── Replay helper ──────────────────────────────────────────────────────────

export function replayEvents(events: readonly CockpitEvent[]): TranscriptState {
  return events.reduce(reduceTranscriptEvent, initialTranscriptState());
}
