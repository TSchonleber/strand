import { describe, expect, it } from "vitest";
import { persona } from "@/config";
import { prefilterText } from "@/util/prefilter";

describe("prefilterText", () => {
  it("passes clean on-topic text", () => {
    const r = prefilterText("p99 dropped to 780ms after switching to streaming jsonl");
    expect(r.ok).toBe(true);
  });

  it("catches a banned topic substring", () => {
    // pick whatever banned topic is configured in the persona
    const topic = persona.banned_topics[0];
    if (!topic) return; // skip if persona has no banned topics
    const r = prefilterText(`hot take on ${topic} from a random thread`);
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("banned_topic:"))).toBe(true);
  });

  it("rejects kill-yourself pattern", () => {
    const r = prefilterText("kys");
    expect(r.ok).toBe(false);
  });
});
