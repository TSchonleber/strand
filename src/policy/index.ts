import { persona, policies } from "@/config";
import { db } from "@/db";
import {
  type Candidate,
  type PolicyVerdict,
  __unsafeMarkApproved,
  __unsafeMarkRejected,
} from "@/types/actions";
import { newDecisionId } from "@/util/idempotency";
import { log } from "@/util/log";
import { prefilterText } from "@/util/prefilter";
import { RateLimiter } from "@/util/ratelimit";
import { checkCooldown } from "./cooldowns";
import { diversityRule } from "./diversity";
import { duplicatesRule } from "./duplicates";
import { rateCapsRule } from "./rateCaps";
import { relevanceRule } from "./topicalRelevance";

/**
 * Policy gate — the ONLY place that mints Candidate<"approved">.
 *
 * Every rule can reject independently. Verdicts collect all reasons
 * rather than short-circuiting — we want full context on rejections
 * for trust calibration and policy tuning.
 */

export interface GateContext {
  rl: RateLimiter;
}

export function makeGate(): GateContext {
  return { rl: new RateLimiter(db()) };
}

function hasText(c: Candidate<"proposed">): string | null {
  const a = c.action;
  return "text" in a ? a.text : null;
}

function requiresReviewByPolicy(c: Candidate<"proposed">): boolean {
  const a = c.action;

  if (c.requiresHumanReview) return true;
  if (policies.human_review_required.dm && a.kind === "dm") return true;
  if (policies.human_review_required.post && a.kind === "post") return true;
  if (
    policies.human_review_required.low_confidence &&
    c.confidence < policies.thresholds.min_confidence_no_review
  ) {
    return true;
  }
  return false;
}

function bannedTopicCheck(c: Candidate<"proposed">): { ok: boolean; reasons: string[] } {
  const txt = hasText(c);
  if (!txt) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  for (const topic of persona.banned_topics) {
    if (txt.toLowerCase().includes(topic.toLowerCase())) {
      reasons.push(`banned_topic:${topic}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function dmSafetyCheck(c: Candidate<"proposed">): { ok: boolean; reasons: string[] } {
  if (c.action.kind !== "dm") return { ok: true, reasons: [] };
  // Hard rule: no DM unless target is marked mutual in the envelope.
  // The Reasoner has to pass this via `targetEntityId` with a prior
  // mutual-check. Without the flag, we reject.
  if (!c.targetEntityId) {
    return { ok: false, reasons: ["dm_no_mutual_context"] };
  }
  return { ok: true, reasons: [] };
}

export function evaluate(ctx: GateContext, c: Candidate<"proposed">): PolicyVerdict {
  const decisionId = newDecisionId();
  const allReasons: string[] = [];
  const allRuleIds: string[] = [];

  const banned = bannedTopicCheck(c);
  if (!banned.ok) {
    allReasons.push(...banned.reasons);
    allRuleIds.push("banned_topic");
  }

  const txt = hasText(c);
  if (txt) {
    const pf = prefilterText(txt);
    if (!pf.ok) {
      allReasons.push(...pf.reasons);
      allRuleIds.push("prefilter");
    }
  }

  const rate = rateCapsRule(c, ctx.rl);
  if (!rate.ok) {
    allReasons.push(...rate.reasons);
    allRuleIds.push(...rate.ruleIds);
  }

  const cd = checkCooldown(db(), c);
  if (!cd.ok) {
    allReasons.push(...cd.reasons);
    allRuleIds.push(...cd.ruleIds);
  }

  const rel = relevanceRule(c);
  if (!rel.ok) {
    allReasons.push(...rel.reasons);
    allRuleIds.push(...rel.ruleIds);
  }

  const dup = duplicatesRule(db(), c);
  if (!dup.ok) {
    allReasons.push(...dup.reasons);
    allRuleIds.push(...dup.ruleIds);
  }

  const div = diversityRule(db(), c);
  if (!div.ok) {
    allReasons.push(...div.reasons);
    allRuleIds.push(...div.ruleIds);
  }

  const dmOk = dmSafetyCheck(c);
  if (!dmOk.ok) {
    allReasons.push(...dmOk.reasons);
    allRuleIds.push("dm.mutual_required");
  }

  if (allReasons.length > 0) {
    log.info(
      { decisionId, kind: c.action.kind, reasons: allReasons, ruleIds: allRuleIds },
      "policy.reject",
    );
    return {
      approved: false,
      candidate: __unsafeMarkRejected(c),
      reasons: allReasons,
      ruleIds: allRuleIds,
    };
  }

  if (requiresReviewByPolicy(c)) {
    log.info({ decisionId, kind: c.action.kind }, "policy.review_required");
    return {
      approved: false,
      candidate: __unsafeMarkRejected(c),
      reasons: ["requires_human_review"],
      ruleIds: ["human_review.required"],
    };
  }

  log.info({ decisionId, kind: c.action.kind }, "policy.approve");
  return {
    approved: true,
    candidate: __unsafeMarkApproved(c),
    cacheableDecisionId: decisionId,
  };
}
