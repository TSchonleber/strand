import { idempotencyKey, newDecisionId, tweetDedupHash } from "@/util/idempotency";
import { describe, expect, it } from "vitest";

describe("idempotencyKey", () => {
  it("is stable across calls with same inputs", () => {
    const a = idempotencyKey({ kind: "like", tweetId: "tw_1" }, ["evt_1"]);
    const b = idempotencyKey({ kind: "like", tweetId: "tw_1" }, ["evt_1"]);
    expect(a).toEqual(b);
  });

  it("differs when source events differ", () => {
    const a = idempotencyKey({ kind: "like", tweetId: "tw_1" }, ["evt_1"]);
    const b = idempotencyKey({ kind: "like", tweetId: "tw_1" }, ["evt_2"]);
    expect(a).not.toEqual(b);
  });

  it("prefixes with action kind", () => {
    const k = idempotencyKey({ kind: "post", text: "hi" }, []);
    expect(k.startsWith("post_")).toBe(true);
  });
});

describe("newDecisionId", () => {
  it("is unique across calls", () => {
    const ids = new Set([
      newDecisionId(),
      newDecisionId(),
      newDecisionId(),
      newDecisionId(),
      newDecisionId(),
    ]);
    expect(ids.size).toBe(5);
  });

  it("has the dec_ prefix", () => {
    expect(newDecisionId().startsWith("dec_")).toBe(true);
  });
});

describe("tweetDedupHash", () => {
  it("is stable for identical post actions", () => {
    const action = { kind: "post" as const, text: "Hello world" };
    const a = tweetDedupHash(action);
    const b = tweetDedupHash(action);
    expect(a).toEqual(b);
  });

  it("differs when text changes", () => {
    const a = tweetDedupHash({ kind: "post", text: "Hello" });
    const b = tweetDedupHash({ kind: "post", text: "World" });
    expect(a).not.toEqual(b);
  });

  it("is case-insensitive (normalizes to lowercase)", () => {
    const a = tweetDedupHash({ kind: "post", text: "Hello World" });
    const b = tweetDedupHash({ kind: "post", text: "hello world" });
    expect(a).toEqual(b);
  });

  it("includes reply target in hash", () => {
    const a = tweetDedupHash({ kind: "reply", text: "Thanks!", tweetId: "123" });
    const b = tweetDedupHash({ kind: "reply", text: "Thanks!", tweetId: "456" });
    expect(a).not.toEqual(b);
  });

  it("includes quote target in hash", () => {
    const a = tweetDedupHash({ kind: "quote", text: "Interesting", tweetId: "123" });
    const b = tweetDedupHash({ kind: "quote", text: "Interesting", tweetId: "456" });
    expect(a).not.toEqual(b);
  });

  it("includes media IDs when present", () => {
    const a = tweetDedupHash({ kind: "post", text: "Hello", mediaIds: ["m1", "m2"] });
    const b = tweetDedupHash({ kind: "post", text: "Hello", mediaIds: ["m2", "m1"] }); // same, sorted
    const c = tweetDedupHash({ kind: "post", text: "Hello", mediaIds: ["m1"] }); // different
    expect(a).toEqual(b); // order shouldn't matter
    expect(a).not.toEqual(c);
  });
});
