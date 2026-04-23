import { createHash, randomBytes } from "node:crypto";
import type { Action } from "@/types/actions";

/**
 * Deterministic idempotency key per (actor, action).
 * Replaying the same candidate produces the same key — prevents
 * dupes if the process restarts between "decided" and "sent to X".
 */
export function idempotencyKey(action: Action, sourceEventIds: string[]): string {
  const payload = JSON.stringify({ action, sourceEventIds: [...sourceEventIds].sort() });
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 24);
  return `${action.kind}_${digest}`;
}

export function newDecisionId(): string {
  return `dec_${randomBytes(8).toString("hex")}`;
}

/**
 * X Tweet dedup hash — SHA-256 of normalized text + reply/quote targets + media.
 * X has no idempotency-key support on POST /2/tweets; this guards against
 * accidental double-posting from network retries or logic bugs.
 *
 * Stored in tweet_dedup table with 72h TTL.
 */
export function tweetDedupHash(
  action: Extract<Action, { kind: "post" | "reply" | "quote" }>,
): string {
  const parts: string[] = [];

  // Normalize: lowercase, collapse whitespace
  parts.push(action.text.toLowerCase().replace(/\s+/g, " ").trim());

  if (action.kind === "reply") {
    parts.push(`in_reply_to:${action.tweetId}`);
  }
  if (action.kind === "quote") {
    parts.push(`quote_tweet:${action.tweetId}`);
  }
  if ("mediaIds" in action && action.mediaIds && action.mediaIds.length > 0) {
    parts.push(...[...action.mediaIds].sort());
  }

  const payload = parts.join("|");
  return createHash("sha256").update(payload).digest("hex");
}
