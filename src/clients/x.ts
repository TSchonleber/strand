import { credentials } from "@/auth";
import type { CredentialStore } from "@/auth";
import { env } from "@/config";
import type { Action } from "@/types/actions";
import { log } from "@/util/log";
import { TwitterApi, type TwitterApiTokens } from "twitter-api-v2";

interface RateLimitState {
  limit: number;
  remaining: number;
  resetAt: number; // unix seconds
}

// In-memory rate limit state per endpoint
const rateLimitMap = new Map<string, RateLimitState>();

// Monthly cap tracking
const TIER_MONTHLY_CAP: Record<"basic" | "pro" | "enterprise", number> = {
  basic: 10_000,
  pro: 1_000_000,
  enterprise: 50_000_000,
};

let monthlyUsage = 0;
let actorHalted = false;

/**
 * Narrow, typed X API v2 wrapper.
 *
 * Read side: only for our own surface — mentions, home timeline, DMs.
 * External scouting (topic search, discovering users, pulling threads we're
 * not in) goes through the provider's server-side tools (xAI `x_search`,
 * Anthropic `web_search`), not here.
 *
 * OAuth credentials resolve through the `CredentialStore`:
 *   - `X_USER_ACCESS_TOKEN` / `X_USER_REFRESH_TOKEN` / `X_USER_TOKEN_EXPIRES_AT`
 *     are read/written atomically via `store.setMany()` on refresh.
 *   - `X_CLIENT_ID` + `X_CLIENT_SECRET` are read once per refresh.
 *
 * By default the OAuthCredentialStore decorator handles refresh transparently:
 *   `store.get("X_USER_ACCESS_TOKEN")` transparently refreshes if within the
 *   60 s expiry window, and returns the fresh token. Callers just ask for the
 *   access token — no manual `refreshUserTokenIfNeeded()` dance.
 */

let _userClient: TwitterApi | null = null;
let _cachedAccessToken: string | null = null;
let _appClient: TwitterApi | null = null;

/** Override the credential store for this module — used by tests + multi-tenant hosts. */
let _storeOverride: CredentialStore | null = null;
export function setXCredentialStore(store: CredentialStore | null): void {
  _storeOverride = store;
  _userClient = null;
  _cachedAccessToken = null;
}

function store(): CredentialStore {
  return _storeOverride ?? credentials();
}

export async function userClient(): Promise<TwitterApi> {
  const accessToken = await store().get("X_USER_ACCESS_TOKEN");
  if (!accessToken) {
    throw new Error("X_USER_ACCESS_TOKEN not set in credential store. Run `pnpm oauth:setup`.");
  }
  if (_userClient && _cachedAccessToken === accessToken) return _userClient;
  _userClient = new TwitterApi(accessToken);
  _cachedAccessToken = accessToken;
  return _userClient;
}

export async function appClient(): Promise<TwitterApi> {
  if (_appClient) return _appClient;
  const bearer = await store().get("X_BEARER_TOKEN");
  if (!bearer) throw new Error("X_BEARER_TOKEN not set in credential store");
  _appClient = new TwitterApi(bearer);
  return _appClient;
}

/**
 * Ensure the user access token is fresh. No-op when the OAuthCredentialStore
 * is in use (`store.get()` refreshes transparently). Kept for callers that
 * want explicit refresh semantics.
 */
export async function refreshUserTokenIfNeeded(): Promise<void> {
  // Ask for the access token; the OAuth decorator's `get()` refreshes
  // transparently if we're within the expiry window.
  await store().get("X_USER_ACCESS_TOKEN");
  // Invalidate the cached client if the token rotated.
  const fresh = await store().get("X_USER_ACCESS_TOKEN");
  if (fresh !== _cachedAccessToken) {
    _userClient = null;
    _cachedAccessToken = null;
    log.info({ svc: "x" }, "x.token_refreshed");
  }
}

async function userId(): Promise<string> {
  const v = await store().get("X_USER_ID");
  if (!v) throw new Error("X_USER_ID not set in credential store");
  return v;
}

// ─── READ: our own surface ───────────────────────────────────

export async function fetchMentions(opts: { sinceId?: string; max?: number } = {}) {
  const client = await userClient();
  const id = await userId();
  const res = await client.v2.userMentionTimeline(id, {
    max_results: opts.max ?? 50,
    ...(opts.sinceId ? { since_id: opts.sinceId } : {}),
    "tweet.fields": ["author_id", "created_at", "conversation_id", "in_reply_to_user_id"],
  });
  return res.data.data ?? [];
}

export async function fetchHomeTimeline(opts: { sinceId?: string; max?: number } = {}) {
  const client = await userClient();
  const id = await userId();
  const res = await client.v2.homeTimeline({
    max_results: opts.max ?? 50,
    ...(opts.sinceId ? { since_id: opts.sinceId } : {}),
    "tweet.fields": ["author_id", "created_at", "public_metrics"],
  });
  void id; // not used by homeTimeline but we validate early
  return res.data.data ?? [];
}

export async function fetchDmEvents(opts: { sinceId?: string; max?: number } = {}) {
  // GET /2/dm_events - requires dm.read scope
  // Available on Basic tier with limited rate limits
  try {
    const client = await userClient();
    // biome-ignore lint/suspicious/noExplicitAny: SDK boundary - v2 DM events
    const c = client.v2 as any;

    // Call listDmEvents if available; otherwise fall back to generic get
    const params: Record<string, unknown> = {
      max_results: opts.max ?? 50,
      event_types: "MessageCreate",
      "dm_event.fields": ["id", "text", "created_at", "sender_id", "event_type"],
    };
    if (opts.sinceId) params["pagination_token"] = opts.sinceId;

    const res = c.listDmEvents ? await c.listDmEvents(params) : await c.get("dm_events", params);
    const raw = (res?.data?.data ?? res?.data ?? []) as Array<{
      id: string;
      text?: string;
      sender_id?: string;
      created_at?: string;
      event_type?: string;
    }>;

    // Track rate limits if headers present
    if (res?.rateLimit) {
      parseRateLimitHeaders(
        {
          "x-rate-limit-limit": String(res.rateLimit.limit ?? ""),
          "x-rate-limit-remaining": String(res.rateLimit.remaining ?? ""),
          "x-rate-limit-reset": String(res.rateLimit.reset ?? ""),
        },
        "dm_events",
      );
    }

    return raw
      .filter((e) => e.event_type === "MessageCreate" || !e.event_type)
      .map((e) => ({
        id: e.id,
        sender_id: e.sender_id ?? "",
        text: e.text ?? "",
        created_at: e.created_at ?? new Date().toISOString(),
      }));
  } catch (err) {
    log.warn({ err, opts }, "x.fetchDmEvents.failed");
    return [] as Array<{ id: string; sender_id: string; text: string; created_at: string }>;
  }
}

// ─── WRITE ───────────────────────────────────────────────────

export interface WriteResult {
  xObjectId: string;
  reversible: boolean;
}

export async function execute(action: Action): Promise<WriteResult> {
  if (action.kind === "project_proposal") {
    throw new Error(
      "project_proposal is an internal Builder-queue action; it must not reach x.execute",
    );
  }
  const t0 = Date.now();
  const c = await userClient();

  const result: WriteResult = await (async () => {
    switch (action.kind) {
      case "like": {
        const id = await userId();
        await c.v2.like(id, action.tweetId);
        return { xObjectId: action.tweetId, reversible: true };
      }
      case "bookmark": {
        const id = await userId();
        await c.v2.bookmark(action.tweetId);
        void id;
        return { xObjectId: action.tweetId, reversible: true };
      }
      case "follow": {
        const id = await userId();
        await c.v2.follow(id, action.userId);
        return { xObjectId: action.userId, reversible: true };
      }
      case "unfollow": {
        const id = await userId();
        await c.v2.unfollow(id, action.userId);
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
  })();

  log.info(
    { svc: "x", kind: action.kind, xObjectId: result.xObjectId, durationMs: Date.now() - t0 },
    "x.execute",
  );
  return result;
}

export async function deleteTweet(tweetId: string): Promise<void> {
  const c = await userClient();
  await c.v2.deleteTweet(tweetId);
}

export function whoAmI(): TwitterApiTokens | null {
  // env.* retained only for legacy callers; prefer store().get() in new code.
  void env;
  return null;
}

// ─── Rate Limit Tracking ─────────────────────────────────────

/**
 * Parse X rate limit headers from a response.
 * Headers: x-rate-limit-limit, x-rate-limit-remaining, x-rate-limit-reset
 */
export function parseRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
  endpoint: string,
): RateLimitState | null {
  const limit = Number.parseInt(String(headers["x-rate-limit-limit"]), 10);
  const remaining = Number.parseInt(String(headers["x-rate-limit-remaining"]), 10);
  const resetAt = Number.parseInt(String(headers["x-rate-limit-reset"]), 10);

  if (Number.isNaN(limit) || Number.isNaN(remaining) || Number.isNaN(resetAt)) {
    return null;
  }

  const state = { limit, remaining, resetAt };
  rateLimitMap.set(endpoint, state);
  return state;
}

/**
 * Get current rate limit state for an endpoint.
 */
export function getRateLimit(endpoint: string): RateLimitState | null {
  return rateLimitMap.get(endpoint) ?? null;
}

/**
 * Increment monthly usage counter. Call this on every X API request.
 */
export function incrementMonthlyUsage(): void {
  monthlyUsage++;
}

/**
 * Get current monthly usage estimate.
 */
export function getMonthlyUsage(): number {
  return monthlyUsage;
}

/**
 * Check if we're approaching the monthly cap (90% threshold).
 * Returns true if Actor should halt.
 */
export function checkMonthlyCapHalt(): boolean {
  const tier = env.TIER;
  const cap = TIER_MONTHLY_CAP[tier];
  const threshold = Math.floor(cap * 0.9);

  if (monthlyUsage >= threshold && !actorHalted) {
    actorHalted = true;
    log.error({ tier, monthlyUsage, cap, threshold }, "x.monthly_cap_halt_triggered");
    return true;
  }
  return actorHalted;
}

/**
 * Reset halt state (for testing or monthly reset).
 */
export function resetMonthlyHalt(): void {
  actorHalted = false;
  monthlyUsage = 0;
}

/**
 * Check if Actor is currently halted due to rate limits.
 */
export function isActorHalted(): boolean {
  return actorHalted;
}

/**
 * Poll X API usage endpoint (GET /2/usage) to verify monthly cap.
 * Updates monthlyUsage with actual server-side count.
 * Returns null if usage endpoint unavailable or request fails.
 */
export async function pollUsage(): Promise<{ used: number; cap: number; resetAt: string } | null> {
  try {
    const c = await userClient();
    // X API v2 usage endpoint - returns monthly usage stats
    // Note: This endpoint may not be available on all tiers
    const res = await c.v2.get("usage", {});
    const data = res.data as {
      data?: {
        daily_project_usage?: Array<{ usage_count: string; date: string }>;
        cap?: string;
        project_id?: string;
      };
    };

    if (data?.data?.daily_project_usage) {
      // Sum up daily usage to get monthly total
      const totalUsed = data.data.daily_project_usage.reduce(
        (sum, day) => sum + (Number.parseInt(day.usage_count, 10) || 0),
        0,
      );
      const cap = Number.parseInt(data.data.cap ?? "0", 10) || TIER_MONTHLY_CAP[env.TIER];

      // Calculate reset date (first of next month)
      const now = new Date();
      const resetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

      // Update local counter
      const oldUsage = monthlyUsage;
      monthlyUsage = totalUsed;

      log.info(
        { usage: totalUsed, cap, oldUsage, delta: totalUsed - oldUsage, resetAt },
        "x.usage_polled",
      );

      // Check if we need to halt based on updated count
      checkMonthlyCapHalt();

      return { used: totalUsed, cap, resetAt };
    }
    return null;
  } catch (err) {
    log.warn({ err }, "x.usage_poll_failed");
    return null;
  }
}
