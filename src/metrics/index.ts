/**
 * Phase 3 metrics collection module.
 *
 * Tracks:
 * - X API health (rate limits, monthly cap)
 * - Mention sentiment baseline
 * - Follower delta
 * - Error rates by action kind
 */

import { env } from "@/config";
import { db } from "@/db";
import { getRateLimit, getMonthlyUsage } from "@/clients/x";
import { log } from "@/util/log";
import type { Action } from "@/types/actions";

const TIER_MONTHLY_CAP: Record<"basic" | "pro" | "enterprise", number> = {
  basic: 10_000,
  pro: 1_000_000,
  enterprise: 50_000_000,
};

/**
 * Record X API health snapshot for an endpoint.
 * Call after each X API request to track rate limit state.
 */
export function recordXHealth(
  endpoint: string,
  opts: {
    healthy?: boolean;
  } = {},
): void {
  try {
    const rateLimit = getRateLimit(endpoint);
    const tier = env.TIER;
    const monthlyCap = TIER_MONTHLY_CAP[tier];
    const monthlyUsed = getMonthlyUsage();

    db()
      .prepare(
        `INSERT INTO x_health
         (endpoint, rate_limit_remaining, rate_limit_limit, rate_limit_reset, monthly_cap, monthly_used, healthy)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        endpoint,
        rateLimit?.remaining ?? null,
        rateLimit?.limit ?? null,
        rateLimit?.resetAt ?? null,
        monthlyCap,
        monthlyUsed,
        opts.healthy !== false ? 1 : 0,
      );
  } catch (err) {
    log.warn({ err, endpoint }, "metrics.x_health_failed");
  }
}

/**
 * Record mention sentiment for a perceived event.
 * Called by Perceiver after analyzing mention sentiment.
 */
export function recordMentionSentiment(
  eventId: string,
  sentiment: {
    score: number;
    magnitude: number;
    model: string;
  } | null,
  error?: string,
): void {
  try {
    db()
      .prepare(
        `INSERT INTO mention_sentiment
         (event_id, sentiment_score, magnitude, model, error)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        sentiment?.score ?? null,
        sentiment?.magnitude ?? null,
        sentiment?.model ?? null,
        error ?? null,
      );
  } catch (err) {
    log.warn({ err, eventId }, "metrics.mention_sentiment_failed");
  }
}

/**
 * Record follower count snapshot.
 * Called periodically to track follower growth.
 */
export function recordFollowerDelta(followers: {
  followersCount: number;
  followingCount?: number;
  listedCount?: number;
}): void {
  try {
    const d = db();

    // Calculate deltas from previous snapshots
    const hourAgo = d
      .prepare(
        `SELECT followers_count FROM follower_delta
         WHERE sampled_at > datetime('now', '-1 hour')
         ORDER BY sampled_at ASC LIMIT 1`,
      )
      .get() as { followers_count: number } | undefined;

    const dayAgo = d
      .prepare(
        `SELECT followers_count FROM follower_delta
         WHERE sampled_at > datetime('now', '-24 hours')
         ORDER BY sampled_at ASC LIMIT 1`,
      )
      .get() as { followers_count: number } | undefined;

    const weekAgo = d
      .prepare(
        `SELECT followers_count FROM follower_delta
         WHERE sampled_at > datetime('now', '-7 days')
         ORDER BY sampled_at ASC LIMIT 1`,
      )
      .get() as { followers_count: number } | undefined;

    const delta1h = hourAgo ? followers.followersCount - hourAgo.followers_count : null;
    const delta24h = dayAgo ? followers.followersCount - dayAgo.followers_count : null;
    const delta7d = weekAgo ? followers.followersCount - weekAgo.followers_count : null;

    d.prepare(
      `INSERT INTO follower_delta
       (followers_count, following_count, listed_count, delta_1h, delta_24h, delta_7d)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      followers.followersCount,
      followers.followingCount ?? null,
      followers.listedCount ?? null,
      delta1h,
      delta24h,
      delta7d,
    );
  } catch (err) {
    log.warn({ err }, "metrics.follower_delta_failed");
  }
}

/**
 * Record action error rate.
 * Called by Actor when an action fails.
 */
export function recordActionError(
  kind: Action["kind"],
  errorCode: string,
): void {
  try {
    const hourBucket = new Date().toISOString().slice(0, 13) + ":00:00Z"; // Round to hour

    const d = db();

    // Increment total for this kind
    d.prepare(
      `INSERT INTO error_rates (hour_bucket, kind, error_code, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(hour_bucket, kind, error_code) DO UPDATE SET count = count + 1`,
    ).run(hourBucket, kind, "TOTAL");

    // Increment specific error code
    d.prepare(
      `INSERT INTO error_rates (hour_bucket, kind, error_code, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(hour_bucket, kind, error_code) DO UPDATE SET count = count + 1`,
    ).run(hourBucket, kind, errorCode);
  } catch (err) {
    log.warn({ err, kind, errorCode }, "metrics.error_rate_failed");
  }
}

/**
 * Get latest health summary for status CLI.
 */
export function getHealthSummary(): {
  xHealth: { endpoint: string; healthy: number; sampledAt: string }[];
  followerDelta: { followersCount: number; delta24h: number | null; sampledAt: string } | null;
  errorRates: { hourBucket: string; kind: string; errorCode: string; count: number }[];
} {
  const d = db();

  const xHealth = d
    .prepare(
      `SELECT endpoint, healthy, sampled_at as sampledAt
       FROM x_health
       WHERE sampled_at > datetime('now', '-1 hour')
       ORDER BY sampled_at DESC
       LIMIT 10`,
    )
    .all() as Array<{ endpoint: string; healthy: number; sampledAt: string }>;

  const followerDelta = d
    .prepare(
      `SELECT followers_count as followersCount, delta_24h as delta24h, sampled_at as sampledAt
       FROM follower_delta
       ORDER BY sampled_at DESC
       LIMIT 1`,
    )
    .get() as { followersCount: number; delta24h: number | null; sampledAt: string } | null;

  const errorRates = d
    .prepare(
      `SELECT hour_bucket as hourBucket, kind, error_code as errorCode, count
       FROM error_rates
       WHERE hour_bucket > datetime('now', '-24 hours')
       ORDER BY hour_bucket DESC, count DESC
       LIMIT 20`,
    )
    .all() as Array<{ hourBucket: string; kind: string; errorCode: string; count: number }>;

  return { xHealth, followerDelta, errorRates };
}
