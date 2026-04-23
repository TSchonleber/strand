import { brain } from "@/clients/brain";
import * as x from "@/clients/x";
import { env } from "@/config";
import { db } from "@/db";
import type { PerceivedEvent } from "@/types/events";
import { loopLog } from "@/util/log";

const log = loopLog("perceiver");

interface PerceiverState {
  lastMentionId?: string;
  lastTimelineId?: string;
  lastDmId?: string;
}

const state: PerceiverState = {};

export async function perceiverTick(): Promise<void> {
  const t0 = Date.now();
  try {
    // Home timeline requires Pro+ tier; skip on Basic
    const skipHomeTimeline = env.TIER === "basic";

    const [mentions, timeline] = await Promise.all([
      x.fetchMentions(
        state.lastMentionId ? { sinceId: state.lastMentionId, max: 50 } : { max: 50 },
      ),
      skipHomeTimeline
        ? Promise.resolve([])
        : x.fetchHomeTimeline(
            state.lastTimelineId ? { sinceId: state.lastTimelineId, max: 50 } : { max: 50 },
          ),
    ]);

    for (const m of mentions) {
      const ev: PerceivedEvent = {
        kind: "mention",
        id: `mention_${m.id}`,
        tweetId: m.id,
        authorId: m.author_id ?? "",
        authorHandle: "",
        text: m.text,
        createdAt: m.created_at ?? new Date().toISOString(),
        ...(m.conversation_id ? { conversationId: m.conversation_id } : {}),
        ...(m.in_reply_to_user_id ? { inReplyToUserId: m.in_reply_to_user_id } : {}),
      };
      await persistEvent(ev);
    }
    if (mentions[0]?.id) state.lastMentionId = mentions[0].id;

    for (const p of timeline) {
      const metrics = p.public_metrics;
      const ev: PerceivedEvent = {
        kind: "timeline_post",
        id: `tl_${p.id}`,
        tweetId: p.id,
        authorId: p.author_id ?? "",
        authorHandle: "",
        text: p.text,
        createdAt: p.created_at ?? new Date().toISOString(),
        ...(metrics
          ? {
              metrics: {
                likeCount: metrics.like_count ?? 0,
                replyCount: metrics.reply_count ?? 0,
                retweetCount: metrics.retweet_count ?? 0,
                quoteCount: metrics.quote_count ?? 0,
              },
            }
          : {}),
      };
      await persistEvent(ev);
    }
    if (timeline[0]?.id) state.lastTimelineId = timeline[0].id;

    log.info(
      {
        mentions: mentions.length,
        timeline: timeline.length,
        durationMs: Date.now() - t0,
        tier: env.TIER,
        homeTimelineSkipped: skipHomeTimeline,
      },
      "perceiver.tick",
    );
  } catch (err) {
    log.error({ err }, "perceiver.tick.failed");
  }
}

async function persistEvent(ev: PerceivedEvent): Promise<void> {
  db()
    .prepare("INSERT OR IGNORE INTO perceived_events (id, kind, payload_json) VALUES (?, ?, ?)")
    .run(ev.id, ev.kind, JSON.stringify(ev));

  try {
    await brain.event_add({ kind: ev.kind, payload: ev });
    db().prepare("UPDATE perceived_events SET forwarded_to_brain = 1 WHERE id = ?").run(ev.id);
  } catch (err) {
    log.warn({ err, eventId: ev.id }, "perceiver.brain_forward_failed");
  }
}

/**
 * Poll DM events separately at 5-min cadence (faster than mention/timeline poll).
 * Per PLAN.md Phase 1: DMs every 5 min, mentions every 10 min.
 */
export async function dmTick(): Promise<void> {
  const t0 = Date.now();
  try {
    const dms = await x.fetchDmEvents(
      state.lastDmId ? { sinceId: state.lastDmId, max: 50 } : { max: 50 },
    );

    for (const dm of dms) {
      const ev: PerceivedEvent = {
        kind: "dm_received",
        id: `dm_${dm.id}`,
        eventId: dm.id,
        authorId: dm.sender_id,
        text: dm.text,
        createdAt: dm.created_at,
      };
      await persistEvent(ev);
    }
    if (dms[0]?.id) state.lastDmId = dms[0].id;

    log.info(
      {
        dms: dms.length,
        durationMs: Date.now() - t0,
      },
      "perceiver.dm_tick",
    );
  } catch (err) {
    log.error({ err }, "perceiver.dm_tick.failed");
  }
}
