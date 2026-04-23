import { db } from "@/db";
import { isDuplicateTweet, recordTweetHash, sweepExpired } from "@/util/sweeper";
import { beforeEach, describe, expect, it } from "vitest";

describe("sweeper", () => {
  beforeEach(() => {
    // Clean slate for each test
    const d = db();
    d.prepare("DELETE FROM tweet_dedup").run();
    d.prepare("DELETE FROM cooldowns").run();
  });

  describe("recordTweetHash + isDuplicateTweet", () => {
    it("records and detects duplicates", () => {
      const d = db();
      const hash = "abc123";

      expect(isDuplicateTweet(d, hash)).toBe(false);
      recordTweetHash(d, hash, "test tweet");
      expect(isDuplicateTweet(d, hash)).toBe(true);
    });

    it("stores text preview truncated to 100 chars", () => {
      const d = db();
      const longText = "a".repeat(200);
      recordTweetHash(d, "hash1", longText);

      const row = d.prepare("SELECT text_preview FROM tweet_dedup WHERE hash = ?").get("hash1") as {
        text_preview: string;
      };
      expect(row.text_preview.length).toBe(100);
    });

    it("sets 72h TTL on new records", () => {
      const d = db();
      const before = Date.now();
      recordTweetHash(d, "hash2", "test");
      const after = Date.now();

      const row = d.prepare("SELECT expires_at FROM tweet_dedup WHERE hash = ?").get("hash2") as {
        expires_at: string;
      };
      const expires = new Date(row.expires_at).getTime();

      // Should be roughly 72 hours in the future
      const expectedMin = before + 71 * 60 * 60 * 1000;
      const expectedMax = after + 73 * 60 * 60 * 1000;
      expect(expires).toBeGreaterThan(expectedMin);
      expect(expires).toBeLessThan(expectedMax);
    });
  });

  describe("sweepExpired", () => {
    it("removes expired tweet_dedup rows", () => {
      const d = db();
      // Insert expired row
      d.prepare("INSERT INTO tweet_dedup (hash, text_preview, expires_at) VALUES (?, ?, ?)").run(
        "expired_hash",
        "text",
        new Date(Date.now() - 1000).toISOString(),
      );

      // Insert future row
      d.prepare("INSERT INTO tweet_dedup (hash, text_preview, expires_at) VALUES (?, ?, ?)").run(
        "future_hash",
        "text",
        new Date(Date.now() + 100000).toISOString(),
      );

      expect(isDuplicateTweet(d, "expired_hash")).toBe(true);
      expect(isDuplicateTweet(d, "future_hash")).toBe(true);

      sweepExpired(d);

      expect(isDuplicateTweet(d, "expired_hash")).toBe(false);
      expect(isDuplicateTweet(d, "future_hash")).toBe(true);
    });

    it("removes expired cooldown rows", () => {
      const d = db();
      const past = Date.now() - 1000;
      const future = Date.now() + 100000;

      d.prepare("INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, ?, ?)").run(
        "target:1",
        "any",
        past,
      );
      d.prepare("INSERT INTO cooldowns (scope, kind, until_at) VALUES (?, ?, ?)").run(
        "target:2",
        "any",
        future,
      );

      sweepExpired(d);

      const rows = d.prepare("SELECT scope FROM cooldowns").all() as Array<{ scope: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.scope).toBe("target:2");
    });
  });
});
