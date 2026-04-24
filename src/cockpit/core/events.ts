import { EventEmitter } from "node:events";
import { z } from "zod";

export const COCKPIT_PROTOCOL_VERSION = 1;
export const COCKPIT_PROTOCOL_HEADER = "X-Cockpit-Protocol";

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export const ProviderIdSchema = z.string().min(1);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const SubagentBackendSchema = z.enum(["internal", "cli-process", "ssh"]);
export type SubagentBackend = z.infer<typeof SubagentBackendSchema>;

export const SkillProposalSchema = z
  .object({
    name: z.string().min(1).optional(),
    rationale: z.string().min(1),
    proposedFrontmatter: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type SkillProposal = z.infer<typeof SkillProposalSchema>;

export const CockpitEventSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("transcript.append"),
    sessionId: z.string().min(1),
    message: MessageSchema,
  }),
  z.object({
    t: z.literal("transcript.delta"),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    chunk: z.string(),
  }),
  z.object({
    t: z.literal("tool.start"),
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    name: z.string().min(1),
    args: z.unknown(),
  }),
  z.object({
    t: z.literal("tool.progress"),
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    chunk: z.string(),
  }),
  z.object({
    t: z.literal("tool.end"),
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
  }),
  z.object({
    t: z.literal("subagent.spawn"),
    subagentId: z.string().min(1),
    backend: SubagentBackendSchema,
    parentSessionId: z.string().min(1),
  }),
  z.object({
    t: z.literal("subagent.event"),
    subagentId: z.string().min(1),
    kind: z.enum(["stdout", "stderr", "status"]),
    chunk: z.string(),
  }),
  z.object({
    t: z.literal("subagent.end"),
    subagentId: z.string().min(1),
    ok: z.boolean(),
    exit: z.number().int().optional(),
  }),
  z.object({
    t: z.literal("skill.proposal"),
    proposalId: z.string().min(1),
    kind: z.enum(["draft", "retire"]),
    payload: SkillProposalSchema,
  }),
  z.object({
    t: z.literal("skill.decision"),
    proposalId: z.string().min(1),
    decision: z.enum(["accepted", "rejected"]),
    by: z.enum(["user", "auto"]),
  }),
  z.object({
    t: z.literal("provider.switch"),
    from: ProviderIdSchema,
    to: ProviderIdSchema,
  }),
  z.object({
    t: z.literal("policy.gate"),
    candidateId: z.string().min(1),
    result: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
  }),
  z.object({
    t: z.literal("budget.warn"),
    sessionId: z.string().min(1),
    dimension: z.enum(["tokens", "usd", "wallclock", "toolCalls"]),
    used: z.number().nonnegative(),
    cap: z.number().nonnegative(),
  }),
  z.object({
    t: z.literal("error"),
    sessionId: z.string().min(1).optional(),
    code: z.string().min(1),
    message: z.string(),
  }),
]);

export type CockpitEvent = z.infer<typeof CockpitEventSchema>;
export type CockpitEventType = CockpitEvent["t"];
export type CockpitEventListener = (event: CockpitEvent) => void;

export function parseCockpitEvent(value: unknown): CockpitEvent {
  return CockpitEventSchema.parse(value);
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(event: CockpitEvent): void {
    const parsed = parseCockpitEvent(event);
    this.emitter.emit("event", parsed);
    this.emitter.emit(parsed.t, parsed);
  }

  subscribe(listener: CockpitEventListener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  subscribeTo<T extends CockpitEventType>(
    type: T,
    listener: (event: Extract<CockpitEvent, { t: T }>) => void,
  ): () => void {
    const wrapped = (event: CockpitEvent): void => {
      listener(event as Extract<CockpitEvent, { t: T }>);
    };
    this.emitter.on(type, wrapped);
    return () => this.emitter.off(type, wrapped);
  }
}
