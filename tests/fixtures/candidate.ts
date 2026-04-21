import type { Action, Candidate, CandidateEnvelope } from "@/types/actions";
import { proposed } from "@/types/actions";

/**
 * Small, boring builders. No smart defaults, no magic — tests fill in what
 * they actually care about and the rest is obvious.
 */

export function makeEnvelope(
  action: Action,
  overrides: Partial<CandidateEnvelope> = {},
): CandidateEnvelope {
  return {
    action,
    rationale: "test",
    confidence: 0.9,
    relevanceScore: 0.9,
    sourceEventIds: [],
    requiresHumanReview: false,
    ...overrides,
  };
}

export function makeCandidate(
  action: Action,
  overrides: Partial<CandidateEnvelope> = {},
): Candidate<"proposed"> {
  return proposed(makeEnvelope(action, overrides));
}

export const fx = {
  post: (text = "a concrete technical observation with a number: p99 dropped to 780ms.", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "post", text }, o),

  reply: (text = "depends on the harness. with a world-model tool you can hold a 40-step task for ~90m.", tweetId = "tw_1", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "reply", tweetId, text }, o),

  quote: (text = "pgvector is fine up to 10M rows, past that use a dedicated engine.", tweetId = "tw_1", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "quote", tweetId, text }, o),

  like: (tweetId = "tw_1", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "like", tweetId }, o),

  bookmark: (tweetId = "tw_1", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "bookmark", tweetId }, o),

  follow: (userId = "u_1", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "follow", userId }, o),

  unfollow: (userId = "u_1", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "unfollow", userId }, o),

  dm: (text = "hey, your post on retrieval lined up with what we saw at scale. wanted to compare notes.", userId = "u_1", o?: Partial<CandidateEnvelope>) =>
    makeCandidate({ kind: "dm", userId, text }, { targetEntityId: `ent:${userId}`, ...o }),
};
