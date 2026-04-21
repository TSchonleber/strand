import { z } from "zod";

export const PerceivedEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mention"),
    id: z.string(),
    tweetId: z.string(),
    authorId: z.string(),
    authorHandle: z.string(),
    text: z.string(),
    createdAt: z.string().datetime(),
    conversationId: z.string().optional(),
    inReplyToUserId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("timeline_post"),
    id: z.string(),
    tweetId: z.string(),
    authorId: z.string(),
    authorHandle: z.string(),
    text: z.string(),
    createdAt: z.string().datetime(),
    metrics: z
      .object({
        likeCount: z.number().int().nonnegative(),
        replyCount: z.number().int().nonnegative(),
        retweetCount: z.number().int().nonnegative(),
        quoteCount: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("dm_received"),
    id: z.string(),
    eventId: z.string(),
    authorId: z.string(),
    text: z.string(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("follow_change"),
    id: z.string(),
    userId: z.string(),
    direction: z.enum(["followed_us", "unfollowed_us"]),
    at: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("engagement_on_ours"),
    id: z.string(),
    tweetId: z.string(),
    actorId: z.string(),
    engagement: z.enum(["like", "reply", "retweet", "quote"]),
    at: z.string().datetime(),
  }),
]);

export type PerceivedEvent = z.infer<typeof PerceivedEventSchema>;
export type PerceivedEventKind = PerceivedEvent["kind"];
