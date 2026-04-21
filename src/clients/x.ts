import { env } from "@/config";
import type { Action } from "@/types/actions";
import { log } from "@/util/log";
import { TwitterApi, type TwitterApiTokens } from "twitter-api-v2";

/**
 * Narrow, typed X API v2 wrapper.
 *
 * Read side: only for our own surface — mentions, home timeline, DMs.
 * External scouting (topic search, discovering users, pulling threads we're
 * not in) goes through Grok's server-side `x_search` tool, not here.
 *
 * Write side: all writes. Every method returns a reversible handle when
 * applicable (tweetId to delete, userId to unfollow).
 */

let _userClient: TwitterApi | null = null;
let _appClient: TwitterApi | null = null;

export function userClient(): TwitterApi {
  if (_userClient) return _userClient;
  if (!env.X_USER_ACCESS_TOKEN) {
    throw new Error("X_USER_ACCESS_TOKEN not set. Run `pnpm oauth:setup`.");
  }
  _userClient = new TwitterApi(env.X_USER_ACCESS_TOKEN);
  return _userClient;
}

export function appClient(): TwitterApi {
  if (_appClient) return _appClient;
  if (!env.X_BEARER_TOKEN) {
    throw new Error("X_BEARER_TOKEN not set");
  }
  _appClient = new TwitterApi(env.X_BEARER_TOKEN);
  return _appClient;
}

// Refresh OAuth2 user token when it's within 60s of expiry.
export async function refreshUserTokenIfNeeded(): Promise<void> {
  const expAt = env.X_USER_TOKEN_EXPIRES_AT;
  if (!expAt || !env.X_USER_REFRESH_TOKEN) return;
  const expMs = Date.parse(expAt);
  if (Number.isNaN(expMs)) return;
  if (expMs - Date.now() > 60_000) return;

  const oauth = new TwitterApi({
    clientId: env.X_CLIENT_ID,
    clientSecret: env.X_CLIENT_SECRET,
  });
  const { accessToken, refreshToken, expiresIn } = await oauth.refreshOAuth2Token(
    env.X_USER_REFRESH_TOKEN,
  );
  Object.assign(process.env, {
    X_USER_ACCESS_TOKEN: accessToken,
    ...(refreshToken ? { X_USER_REFRESH_TOKEN: refreshToken } : {}),
    X_USER_TOKEN_EXPIRES_AT: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  _userClient = null;
  log.info({ svc: "x" }, "x.token_refreshed");
}

// ─── READ: our own surface ───────────────────────────────────

export async function fetchMentions(opts: { sinceId?: string; max?: number } = {}) {
  await refreshUserTokenIfNeeded();
  if (!env.X_USER_ID) throw new Error("X_USER_ID not set");
  const res = await userClient().v2.userMentionTimeline(env.X_USER_ID, {
    max_results: opts.max ?? 50,
    ...(opts.sinceId ? { since_id: opts.sinceId } : {}),
    "tweet.fields": ["author_id", "created_at", "conversation_id", "in_reply_to_user_id"],
  });
  return res.data.data ?? [];
}

export async function fetchHomeTimeline(opts: { sinceId?: string; max?: number } = {}) {
  await refreshUserTokenIfNeeded();
  if (!env.X_USER_ID) throw new Error("X_USER_ID not set");
  const res = await userClient().v2.homeTimeline({
    max_results: opts.max ?? 50,
    ...(opts.sinceId ? { since_id: opts.sinceId } : {}),
    "tweet.fields": ["author_id", "created_at", "public_metrics"],
  });
  return res.data.data ?? [];
}

export async function fetchDmEvents(opts: { sinceId?: string; max?: number } = {}) {
  await refreshUserTokenIfNeeded();
  // v2 DM endpoints vary across tiers; wire exactly per your tier's reference.
  // Stub returns [] until DMs are in scope per the phase plan.
  log.debug({ opts }, "x.fetchDmEvents.stub");
  return [] as Array<{ id: string; sender_id: string; text: string; created_at: string }>;
}

// ─── WRITE ───────────────────────────────────────────────────

export interface WriteResult {
  xObjectId: string;
  reversible: boolean;
}

async function withRefresh<T>(fn: () => Promise<T>): Promise<T> {
  await refreshUserTokenIfNeeded();
  return fn();
}

export async function execute(action: Action): Promise<WriteResult> {
  if (action.kind === "project_proposal") {
    throw new Error(
      "project_proposal is an internal Builder-queue action; it must not reach x.execute",
    );
  }
  const t0 = Date.now();
  const result = await withRefresh(async () => {
    const c = userClient();
    switch (action.kind) {
      case "like": {
        if (!env.X_USER_ID) throw new Error("X_USER_ID not set");
        await c.v2.like(env.X_USER_ID, action.tweetId);
        return { xObjectId: action.tweetId, reversible: true };
      }
      case "bookmark": {
        if (!env.X_USER_ID) throw new Error("X_USER_ID not set");
        await c.v2.bookmark(action.tweetId);
        return { xObjectId: action.tweetId, reversible: true };
      }
      case "follow": {
        if (!env.X_USER_ID) throw new Error("X_USER_ID not set");
        await c.v2.follow(env.X_USER_ID, action.userId);
        return { xObjectId: action.userId, reversible: true };
      }
      case "unfollow": {
        if (!env.X_USER_ID) throw new Error("X_USER_ID not set");
        await c.v2.unfollow(env.X_USER_ID, action.userId);
        return { xObjectId: action.userId, reversible: false };
      }
      case "post": {
        const r = await c.v2.tweet({ text: action.text });
        return { xObjectId: r.data.id, reversible: true };
      }
      case "reply": {
        const r = await c.v2.tweet({
          text: action.text,
          reply: { in_reply_to_tweet_id: action.tweetId },
        });
        return { xObjectId: r.data.id, reversible: true };
      }
      case "quote": {
        const r = await c.v2.tweet({
          text: action.text,
          quote_tweet_id: action.tweetId,
        });
        return { xObjectId: r.data.id, reversible: true };
      }
      case "dm": {
        const r = await c.v2.sendDmToParticipant(action.userId, { text: action.text });
        return { xObjectId: r.dm_event_id, reversible: false };
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unhandled action kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  });

  log.info(
    { svc: "x", kind: action.kind, xObjectId: result.xObjectId, durationMs: Date.now() - t0 },
    "x.execute",
  );
  return result;
}

export async function deleteTweet(tweetId: string): Promise<void> {
  await withRefresh(() => userClient().v2.deleteTweet(tweetId));
}

export function whoAmI(): TwitterApiTokens | null {
  return null; // placeholder for debug CLI
}
