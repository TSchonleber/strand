import { brain } from "@/clients/brain";
import { userClient } from "@/clients/x";
import { env } from "@/config";
import { log } from "@/util/log";
import type { UserV2 } from "twitter-api-v2";

/**
 * One-shot ingestion of the account's follower list into brainctl as
 * entity observations. Scaffolding only: real X API calls happen ONLY
 * when X_USER_ACCESS_TOKEN + X_USER_ID are set. Without creds it prints
 * a clear message and exits 0.
 *
 * Cost model:
 *   - GET /2/users/:id/followers?max_results=100 → 1 API call per 100 followers.
 *   - On TIER=basic (10k read+write cap/mo), burn no more than 5% = 500 calls.
 *     That ceilings us at ~50,000 followers per ingest run before we refuse.
 *   - On TIER=pro we still refuse >5% of 1M = 50,000 calls to avoid runaway.
 *
 * Mutual tagging currently requires the `following` list too. The v2
 * `/users/:id/following` endpoint is Pro+ like follow writes. On Basic
 * we log a TODO and skip the mutual pass.
 *
 * Usage: pnpm tsx scripts/ingest-followers.ts
 */

const FOLLOWERS_PER_CALL = 100; // v2 max_results cap
const TIER_MONTHLY_CAP: Record<"basic" | "pro" | "enterprise", number> = {
  basic: 10_000,
  pro: 1_000_000,
  enterprise: 50_000_000,
};
const MAX_CALL_BUDGET_FRACTION = 0.05; // burn at most 5% of monthly cap per run

function maxCallBudget(tier: "basic" | "pro" | "enterprise"): number {
  return Math.floor(TIER_MONTHLY_CAP[tier] * MAX_CALL_BUDGET_FRACTION);
}

async function ensureIngestEntity(u: UserV2): Promise<void> {
  const identifier = `user:${u.id}`;
  try {
    await brain.entity_observe({
      identifier,
      handle: u.username,
      observations: "follower_of_strand; sourced_via_ingest_followers",
    });
  } catch (err) {
    // Fall back: create the entity, then observe. entity_observe on brainctl
    // may require the entity to exist on some backends.
    log.debug({ err, identifier }, "ingest.entity_observe_failed_falling_back_to_create");
    await brain.entity_create({
      kind: "person",
      name: `@${u.username}`,
      aliases: [u.username, u.id, identifier],
      attributes: {
        x_user_id: u.id,
        display_name: u.name,
        verified: Boolean(u.verified),
        followers_count: u.public_metrics?.followers_count ?? null,
        following_count: u.public_metrics?.following_count ?? null,
        ingested_at: new Date().toISOString(),
      },
    });
    await brain.entity_observe({
      identifier,
      handle: u.username,
      observations: "follower_of_strand; sourced_via_ingest_followers",
    });
  }
}

async function main(): Promise<void> {
  if (!env.X_USER_ACCESS_TOKEN || !env.X_USER_ID) {
    process.stdout.write(
      "ingest-followers: not running — set X_USER_ACCESS_TOKEN + X_USER_ID first.\n",
    );
    process.exit(0);
  }

  const tier = env.TIER;
  const callBudget = maxCallBudget(tier);
  log.info(
    { tier, monthlyCap: TIER_MONTHLY_CAP[tier], callBudget, followersPerCall: FOLLOWERS_PER_CALL },
    "ingest.cost_estimate",
  );

  const client = await userClient();
  const userId = env.X_USER_ID;

  let fetchedUsers = 0;
  let calls = 0;
  let cursor: string | undefined;
  const followerIds = new Set<string>();

  do {
    if (calls >= callBudget) {
      process.stderr.write(
        `refusing: projected cost would exceed ${Math.round(MAX_CALL_BUDGET_FRACTION * 100)}% of TIER=${tier} monthly cap (${callBudget} calls).\n`,
      );
      process.exit(2);
    }

    const res = await client.v2.followers(userId, {
      max_results: FOLLOWERS_PER_CALL,
      "user.fields": ["id", "username", "name", "public_metrics", "verified"],
      ...(cursor ? { pagination_token: cursor } : {}),
    });
    calls++;
    const users = (res.data ?? []) as UserV2[];
    cursor = res.meta?.next_token;

    for (const u of users) {
      followerIds.add(u.id);
      await ensureIngestEntity(u);
      fetchedUsers++;
    }
  } while (cursor);

  // Mutual pass.
  let mutualTodo = true;
  let mutualsCount = 0;
  if (tier === "pro" || tier === "enterprise") {
    try {
      let followingCursor: string | undefined;
      const followingIds = new Set<string>();
      do {
        if (calls >= callBudget) break;
        const res = await client.v2.following(userId, {
          max_results: FOLLOWERS_PER_CALL,
          ...(followingCursor ? { pagination_token: followingCursor } : {}),
        });
        calls++;
        for (const u of (res.data ?? []) as UserV2[]) followingIds.add(u.id);
        followingCursor = res.meta?.next_token;
      } while (followingCursor);

      for (const id of followerIds) {
        if (followingIds.has(id)) {
          mutualsCount++;
          await brain.entity_observe({
            identifier: `user:${id}`,
            observations: "mutual_follow_with_strand",
          });
        }
      }
      mutualTodo = false;
    } catch (err) {
      log.warn({ err }, "ingest.following_fetch_failed");
    }
  } else {
    log.warn(
      { tier },
      "ingest.mutual_pass_skipped: /2/users/:id/following not available on this tier (TODO: wire via Grok x_search or upgrade)",
    );
  }

  const summary = {
    tier,
    calls,
    callBudget,
    followers: fetchedUsers,
    mutuals: mutualsCount,
    mutualPassTodo: mutualTodo,
  };
  log.info(summary, "ingest.done");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    log.error({ err }, "ingest.failed");
    process.exit(1);
  });
}
