/**
 * Phase 3 Actor tests: like/bookmark live, everything else shadow.
 */

import { executeApproved } from "@/loops/actor";
import { type CandidateEnvelope, __unsafeMarkApproved, proposed } from "@/types/actions";
import type { RateLimiter } from "@/util/ratelimit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("@/clients/brain", () => ({
  brain: {
    outcome_annotate: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/clients/x", async () => {
  const actual = await vi.importActual<typeof import("@/clients/x")>("@/clients/x");
  return {
    ...actual,
    execute: vi.fn().mockResolvedValue({ xObjectId: "tweet_123", reversible: true }),
    checkMonthlyCapHalt: vi.fn().mockReturnValue(false),
    incrementMonthlyUsage: vi.fn(),
    isActorHalted: vi.fn().mockReturnValue(false),
  };
});

vi.mock("@/metrics", () => ({
  recordActionError: vi.fn(),
}));

vi.mock("@/config", () => ({
  env: {
    LOG_LEVEL: "fatal",
    STRAND_MODE: "live",
    TIER: "basic",
  },
  policies: {
    caps_per_day: {
      likes: 200,
      bookmarks: 50,
    },
  },
  effectiveCap: vi.fn((k: string) => {
    const caps: Record<string, number> = { likes: 100, bookmarks: 25 };
    return caps[k] ?? 0;
  }),
}));

vi.mock("@/db", () => {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }),
    }),
  };
  return {
    db: vi.fn().mockReturnValue(mockDb),
  };
});

vi.mock("@/policy/cooldowns", () => ({
  recordActionCooldowns: vi.fn(),
}));

vi.mock("@/policy/duplicates", () => ({
  recordPostText: vi.fn(),
}));

vi.mock("@/util/idempotency", () => ({
  idempotencyKey: vi.fn().mockReturnValue("test_key_123"),
  tweetDedupHash: vi.fn().mockReturnValue("hash_123"),
}));

vi.mock("@/util/sweeper", () => ({
  isDuplicateTweet: vi.fn().mockReturnValue(false),
  recordTweetHash: vi.fn(),
}));

describe("Phase 3 Actor", () => {
  let mockRl: RateLimiter;

  beforeEach(() => {
    mockRl = {
      check: vi.fn().mockReturnValue({ allowed: true }),
      increment: vi.fn(),
    } as unknown as RateLimiter;
    vi.clearAllMocks();
  });

  const deps = () => ({ rl: mockRl });

  describe("live mode - low-risk actions", () => {
    it("should execute like action in live mode (not shadow)", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "like", tweetId: "12345" },
        rationale: "Test like",
        confidence: 0.9,
        relevanceScore: 0.8,
        sourceEventIds: ["event_1"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_123");

      // Should have called X execute (not shadow)
      expect(execute).toHaveBeenCalledWith(candidate.action);
    });

    it("should execute bookmark action in live mode (not shadow)", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "bookmark", tweetId: "67890" },
        rationale: "Test bookmark",
        confidence: 0.85,
        relevanceScore: 0.75,
        sourceEventIds: ["event_2"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_456");

      // Should have called X execute (not shadow)
      expect(execute).toHaveBeenCalledWith(candidate.action);
    });
  });

  describe("live mode - non-low-risk actions (shadow)", () => {
    it("should NOT execute reply in live mode (should be shadow)", async () => {
      const { execute } = await import("@/clients/x");
      const { db } = await import("@/db");

      const envelope: CandidateEnvelope = {
        action: { kind: "reply", tweetId: "12345", text: "Test reply" },
        rationale: "Test reply",
        confidence: 0.9,
        relevanceScore: 0.8,
        sourceEventIds: ["event_1"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_789");

      // Should NOT have called X execute (shadow)
      expect(execute).not.toHaveBeenCalled();

      // Should have recorded shadow execution
      const dbPrepare = db().prepare as ReturnType<typeof vi.fn>;
      expect(dbPrepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE action_log SET status = 'executed'"),
      );
    });

    it("should NOT execute quote in live mode (should be shadow)", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "quote", tweetId: "12345", text: "Test quote" },
        rationale: "Test quote",
        confidence: 0.9,
        relevanceScore: 0.8,
        sourceEventIds: ["event_1"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_abc");

      expect(execute).not.toHaveBeenCalled();
    });

    it("should NOT execute post in live mode (should be shadow)", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "post", text: "Test post" },
        rationale: "Test post",
        confidence: 0.9,
        relevanceScore: 0.8,
        sourceEventIds: ["event_1"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_def");

      expect(execute).not.toHaveBeenCalled();
    });

    it("should NOT execute follow in live mode (should be shadow)", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "follow", userId: "user_123" },
        rationale: "Test follow",
        confidence: 0.9,
        relevanceScore: 0.8,
        sourceEventIds: ["event_1"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_ghi");

      expect(execute).not.toHaveBeenCalled();
    });

    it("should NOT execute DM in live mode (should be shadow)", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "dm", userId: "user_123", text: "Test DM" },
        rationale: "Test DM",
        confidence: 0.9,
        relevanceScore: 0.8,
        sourceEventIds: ["event_1"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_jkl");

      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("shadow mode - all actions", () => {
    beforeEach(async () => {
      // Override env for these tests
      const { env } = await import("@/config");
      env.STRAND_MODE = "shadow";
    });

    it("should NOT execute like in shadow mode", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "like", tweetId: "12345" },
        rationale: "Test like",
        confidence: 0.9,
        relevanceScore: 0.8,
        sourceEventIds: ["event_1"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_mno");

      expect(execute).not.toHaveBeenCalled();
    });

    it("should NOT execute bookmark in shadow mode", async () => {
      const { execute } = await import("@/clients/x");

      const envelope: CandidateEnvelope = {
        action: { kind: "bookmark", tweetId: "67890" },
        rationale: "Test bookmark",
        confidence: 0.85,
        relevanceScore: 0.75,
        sourceEventIds: ["event_2"],
        requiresHumanReview: false,
      };
      const candidate = __unsafeMarkApproved(proposed(envelope));

      await executeApproved(deps(), candidate, "decision_pqr");

      expect(execute).not.toHaveBeenCalled();
    });
  });
});
