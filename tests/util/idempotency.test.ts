import { describe, expect, it } from "vitest";
import { idempotencyKey, newDecisionId } from "@/util/idempotency";

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
