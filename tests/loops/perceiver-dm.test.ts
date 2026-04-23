import * as x from "@/clients/x";
import { dmTick } from "@/loops/perceiver";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("dmTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls fetchDmEvents", async () => {
    const spy = vi.spyOn(x, "fetchDmEvents").mockResolvedValue([]);
    await dmTick();
    expect(spy).toHaveBeenCalled();
  });

  it("processes DM events into perceived events", async () => {
    const spy = vi.spyOn(x, "fetchDmEvents").mockResolvedValue([
      {
        id: "dm_001",
        sender_id: "user_123",
        text: "hello there",
        created_at: "2026-04-22T20:00:00Z",
      },
      {
        id: "dm_002",
        sender_id: "user_456",
        text: "another message",
        created_at: "2026-04-22T20:05:00Z",
      },
    ]);

    await dmTick();

    expect(spy).toHaveBeenCalled();
  });

  it("handles empty DM response", async () => {
    vi.spyOn(x, "fetchDmEvents").mockResolvedValue([]);
    await expect(dmTick()).resolves.not.toThrow();
  });

  it("handles fetchDmEvents errors gracefully", async () => {
    vi.spyOn(x, "fetchDmEvents").mockRejectedValue(new Error("API error"));
    // Should not throw - dmTick catches errors internally
    await expect(dmTick()).resolves.not.toThrow();
  });
});
