import { effectiveCap, policies } from "@/config";
import { rateCapsRule } from "@/policy/rateCaps";
import { RateLimiter } from "@/util/ratelimit";
import { beforeEach, describe, expect, it } from "vitest";
import { fx } from "../fixtures/candidate";
import { freshDb } from "../helpers/db";

describe("rateCapsRule", () => {
  let rl: RateLimiter;

  beforeEach(() => {
    rl = new RateLimiter(freshDb());
  });

  it("allows a reply below daily cap", () => {
    const r = rateCapsRule(fx.reply(), rl);
    expect(r.ok).toBe(true);
  });

  it("rejects a like once daily cap is reached", () => {
    const cap = effectiveCap("likes");
    for (let i = 0; i < cap; i++) {
      rl.increment({ scope: "global", kind: "like", windowMs: 24 * 60 * 60 * 1000 });
    }
    const r = rateCapsRule(fx.like(), rl);
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("rate.daily");
    expect(r.reasons[0]).toMatch(/daily_cap_exceeded:like/);
  });

  it("enforces hourly cap on follows separately from daily", () => {
    const hourMs = 60 * 60 * 1000;
    for (let i = 0; i < policies.caps_per_hour.follows; i++) {
      rl.increment({ scope: "global", kind: "follow", windowMs: hourMs });
    }
    const r = rateCapsRule(fx.follow(), rl);
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("rate.hourly.follow");
  });

  it("enforces hourly cap on replies", () => {
    const hourMs = 60 * 60 * 1000;
    for (let i = 0; i < policies.caps_per_hour.replies; i++) {
      rl.increment({ scope: "global", kind: "reply", windowMs: hourMs });
    }
    const r = rateCapsRule(fx.reply(), rl);
    expect(r.ok).toBe(false);
    expect(r.ruleIds).toContain("rate.hourly.reply");
  });

  it("ramp_multiplier actually reduces the effective cap", () => {
    // shadow config has ramp_multiplier = 0.25 → effective cap is floor(base * 0.25)
    const base = policies.caps_per_day.posts;
    const eff = effectiveCap("posts");
    expect(eff).toBe(Math.floor(base * policies.ramp_multiplier));
    expect(eff).toBeLessThan(base);
  });
});
