import { z } from "zod";

// ─── Action discriminated union ──────────────────────────────

export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("like"), tweetId: z.string().min(1) }),
  z.object({ kind: z.literal("bookmark"), tweetId: z.string().min(1) }),
  z.object({
    kind: z.literal("reply"),
    tweetId: z.string().min(1),
    text: z.string().min(1).max(280),
  }),
  z.object({
    kind: z.literal("quote"),
    tweetId: z.string().min(1),
    text: z.string().min(1).max(280),
  }),
  z.object({
    kind: z.literal("post"),
    text: z.string().min(1).max(280),
    mediaIds: z.array(z.string()).max(4).optional(),
  }),
  z.object({ kind: z.literal("follow"), userId: z.string().min(1) }),
  z.object({ kind: z.literal("unfollow"), userId: z.string().min(1) }),
  z.object({
    kind: z.literal("dm"),
    userId: z.string().min(1),
    text: z.string().min(1).max(10000),
  }),
  // Internal action: no X write. Dispatched by Actor to the Builder queue
  // when Reasoner spots a buildable idea from a user who can't ship it alone.
  // All outbound communication about a proposal (DM / reply to original poster)
  // is a separate `dm` / `reply` action with `requiresHumanReview: true`.
  z.object({
    kind: z.literal("project_proposal"),
    sourceTweetId: z.string().min(1),
    sourceUserId: z.string().min(1),
    ideaSummary: z.string().min(20).max(1000),
    problemStatement: z.string().min(20).max(2000),
    proposedApproach: z.string().min(20).max(3000),
    estimatedEffortHours: z.number().int().min(1).max(200),
    requiredCapabilities: z.array(z.string()).min(1).max(20),
    feasibilityScore: z.number().min(0).max(1),
    legalRiskFlags: z.array(z.string()).default([]),
    competitiveLandscape: z.string().max(1000).optional(),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;
export type ActionKind = Action["kind"];

// ─── Candidate envelope emitted by Reasoner ──────────────────

export const CandidateEnvelopeSchema = z.object({
  action: ActionSchema,
  rationale: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  targetEntityId: z.string().optional(),
  relevanceScore: z.number().min(0).max(1),
  sourceEventIds: z.array(z.string()).default([]),
  requiresHumanReview: z.boolean().default(false),
  modelResponseId: z.string().optional(),
});

export type CandidateEnvelope = z.infer<typeof CandidateEnvelopeSchema>;

// ─── Typestate wrapper ───────────────────────────────────────
// Only the policy gate can mint `Candidate<Approved>`. Actor accepts
// only Approved. Making this a compile-error keeps the architecture
// honest — a loose CandidateEnvelope cannot reach the Actor.

export type CandidateState = "proposed" | "approved" | "rejected";

declare const brand: unique symbol;
type Brand<S extends CandidateState> = { readonly [brand]: S };

export type Candidate<S extends CandidateState = "proposed"> =
  CandidateEnvelope & Brand<S>;

export function proposed(env: CandidateEnvelope): Candidate<"proposed"> {
  return env as Candidate<"proposed">;
}

// NOTE: `approve` is ONLY exported from src/policy/index.ts.
// This type lives here; the minting function lives in the policy module.
export function __unsafeMarkApproved(
  c: Candidate<"proposed">,
): Candidate<"approved"> {
  return c as unknown as Candidate<"approved">;
}

export function __unsafeMarkRejected(
  c: Candidate<"proposed">,
): Candidate<"rejected"> {
  return c as unknown as Candidate<"rejected">;
}

// ─── Policy verdict ──────────────────────────────────────────

export interface PolicyApproved {
  approved: true;
  candidate: Candidate<"approved">;
  cacheableDecisionId: string;
}

export interface PolicyRejected {
  approved: false;
  candidate: Candidate<"rejected">;
  reasons: string[];
  ruleIds: string[];
}

export type PolicyVerdict = PolicyApproved | PolicyRejected;

// ─── Executed action (post-X) ────────────────────────────────

export const ExecutedActionSchema = z.object({
  idempotencyKey: z.string(),
  candidate: CandidateEnvelopeSchema,
  xObjectId: z.string().optional(), // tweet/DM id returned by X
  success: z.boolean(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  executedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  reversible: z.boolean(),
  reversalDeadlineAt: z.string().datetime().optional(),
});

export type ExecutedAction = z.infer<typeof ExecutedActionSchema>;
