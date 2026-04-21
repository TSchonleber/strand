import type { UserV2 } from "twitter-api-v2";
import { brain } from "@/clients/brain";
import { userClient } from "@/clients/x";
import { env } from "@/config";
import { log } from "@/util/log";

/**
 * One-shot ingestion of the account's current followers + following lists
 * into brainctl as entities. Run once after oauth:setup and memory:bootstrap
 * so the Reasoner has cold-start context on who we're already connected to.
 *
 * Usage: pnpm tsx scripts/ingest-followers.ts
 */

interface Page {
  data: UserV2[];
  next: string | undefined;
}

async function main(): Promise<void> {
  if (!env.X_USER_ID) {
    process.stderr.write("X_USER_ID missing — run `pnpm oauth:setup` first\n");
    process.exit(2);
  }
  const userId = env.X_USER_ID;
  const client = userClient();

  log.info({}, "ingest.followers.start");

  const followers = await paginate(async (pageToken): Promise<Page> => {
    const res = await client.v2.followers(userId, {
      max_results: 1000,
      "user.fields": ["id", "username", "name", "description", "public_metrics", "verified"],
      ...(pageToken ? { pagination_token: pageToken } : {}),
    });
    return {
      data: (res.data ?? []) as UserV2[],
      next: res.meta?.next_token,
    };
  });
  log.info({ count: followers.length }, "ingest.followers.fetched");

  const following = await paginate(async (pageToken): Promise<Page> => {
    const res = await client.v2.following(userId, {
      max_results: 1000,
      "user.fields": ["id", "username", "name", "description", "public_metrics", "verified"],
      ...(pageToken ? { pagination_token: pageToken } : {}),
    });
    return {
      data: (res.data ?? []) as UserV2[],
      next: res.meta?.next_token,
    };
  });
  log.info({ count: following.length }, "ingest.following.fetched");

  const followerIds = new Set(followers.map((f) => f.id));
  const followingIds = new Set(following.map((f) => f.id));
  const mutuals = new Set([...followerIds].filter((id) => followingIds.has(id)));

  let written = 0;
  for (const u of [...followers, ...following]) {
    const isMutual = mutuals.has(u.id);
    const isFollower = followerIds.has(u.id);
    const isFollowing = followingIds.has(u.id);

    await brain.entity_create({
      kind: "person",
      name: `@${u.username}`,
      aliases: [u.username, u.id],
      attributes: {
        x_user_id: u.id,
        display_name: u.name,
        bio: u.description ?? null,
        verified: Boolean(u.verified),
        followers_count: u.public_metrics?.followers_count ?? null,
        following_count: u.public_metrics?.following_count ?? null,
        relation: isMutual ? "mutual" : isFollower ? "follower" : "following",
        is_mutual: isMutual,
        is_follower: isFollower,
        is_following: isFollowing,
        ingested_at: new Date().toISOString(),
      },
    });
    written++;
  }

  log.info(
    { followers: followers.length, following: following.length, mutuals: mutuals.size, written },
    "ingest.done",
  );
  process.stdout.write(
    `ingested: followers=${followers.length} following=${following.length} mutuals=${mutuals.size}\n`,
  );
  process.exit(0);
}

async function paginate(fetchPage: (pageToken: string | undefined) => Promise<Page>): Promise<UserV2[]> {
  const out: UserV2[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    out.push(...page.data);
    cursor = page.next;
  } while (cursor);
  return out;
}

void main().catch((err) => {
  log.error({ err }, "ingest.failed");
  process.exit(1);
});
