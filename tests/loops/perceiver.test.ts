import * as x from "@/clients/x";
import { env } from "@/config";
import { perceiverTick } from "@/loops/perceiver";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("perceiverTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips home timeline on basic tier", async () => {
    // Mock the env module
    vi.mocked(env).TIER = "basic";

    const fetchMentionsSpy = vi.spyOn(x, "fetchMentions").mockResolvedValue([]);
    const fetchHomeTimelineSpy = vi.spyOn(x, "fetchHomeTimeline").mockResolvedValue([]);

    await perceiverTick();

    expect(fetchMentionsSpy).toHaveBeenCalled();
    expect(fetchHomeTimelineSpy).not.toHaveBeenCalled();
  });

  it("fetches home timeline on pro tier", async () => {
    vi.mocked(env).TIER = "pro";

    const fetchMentionsSpy = vi.spyOn(x, "fetchMentions").mockResolvedValue([]);
    const fetchHomeTimelineSpy = vi.spyOn(x, "fetchHomeTimeline").mockResolvedValue([]);

    await perceiverTick();

    expect(fetchMentionsSpy).toHaveBeenCalled();
    expect(fetchHomeTimelineSpy).toHaveBeenCalled();
  });

  it("fetches home timeline on enterprise tier", async () => {
    vi.mocked(env).TIER = "enterprise";

    const fetchMentionsSpy = vi.spyOn(x, "fetchMentions").mockResolvedValue([]);
    const fetchHomeTimelineSpy = vi.spyOn(x, "fetchHomeTimeline").mockResolvedValue([]);

    await perceiverTick();

    expect(fetchMentionsSpy).toHaveBeenCalled();
    expect(fetchHomeTimelineSpy).toHaveBeenCalled();
  });
});
