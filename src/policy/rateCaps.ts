import { effectiveCap, policies } from "@/config";
import type { Candidate } from "@/types/actions";
import type { RateLimiter } from "@/util/ratelimit";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface RateRuleResult {
  ok: boolean;
  reasons: string[];
  ruleIds: string[];
}

type XWriteKind = Exclude<Candidate<"proposed">["action"]["kind"], "project_proposal">;

function kindToCapKey(kind: XWriteKind): keyof typeof policies.caps_per_day {
  switch (kind) {
    case "post":
      return "posts";
    case "reply":
      return "replies";
    case "quote":
      return "quotes";
    case "follow":
      return "follows";
    case "unfollow":
      return "unfollows";
    case "like":
      return "likes";
    case "bookmark":
      return "bookmarks";
    case "dm":
      return "dms";
  }
}

export function rateCapsRule(c: Candidate<"proposed">, rl: RateLimiter): RateRuleResult {
  const reasons: string[] = [];
  const ruleIds: string[] = [];

  const kind = c.action.kind;
  if (kind === "project_proposal") {
    return { ok: true, reasons, ruleIds };
  }
  const capKey = kindToCapKey(kind);
  const dailyCap = effectiveCap(capKey);

  const daily = rl.check({
    scope: "global",
    kind,
    windowMs: DAY_MS,
    capacity: dailyCap,
  });
  if (!daily.allowed) {
    reasons.push(`daily_cap_exceeded:${kind}:${dailyCap}`);
    ruleIds.push("rate.daily");
  }

  // Tighter hour caps on follow/reply, per config
  if (kind === "follow") {
    const hourly = rl.check({
      scope: "global",
      kind,
      windowMs: HOUR_MS,
      capacity: policies.caps_per_hour.follows,
    });
    if (!hourly.allowed) {
      reasons.push(`hourly_cap_exceeded:follow:${policies.caps_per_hour.follows}`);
      ruleIds.push("rate.hourly.follow");
    }
  }
  if (kind === "reply") {
    const hourly = rl.check({
      scope: "global",
      kind,
      windowMs: HOUR_MS,
      capacity: policies.caps_per_hour.replies,
    });
    if (!hourly.allowed) {
      reasons.push(`hourly_cap_exceeded:reply:${policies.caps_per_hour.replies}`);
      ruleIds.push("rate.hourly.reply");
    }
  }

  return { ok: reasons.length === 0, reasons, ruleIds };
}
