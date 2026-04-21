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
