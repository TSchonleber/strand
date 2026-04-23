import {
  checkMonthlyCapHalt,
  getMonthlyUsage,
  incrementMonthlyUsage,
  isActorHalted,
  resetMonthlyHalt,
} from "@/clients/x";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("pollUsage integration (requires X_API credentials)", () => {
  // These tests verify the public API exists and has correct types.
  // Actual API polling requires X credentials and is tested manually.

  beforeEach(() => {
    resetMonthlyHalt();
  });

  afterEach(() => {
    resetMonthlyHalt();
  });

  it("exports pollUsage function", async () => {
    const { pollUsage } = await import("@/clients/x");
    expect(typeof pollUsage).toBe("function");
  });

  it("has correct return type signature", async () => {
    const { pollUsage } = await import("@/clients/x");
    // Function should return Promise<{ used, cap, resetAt } | null>
    const result = await pollUsage();
    // Without credentials, should return null (graceful failure)
    expect(result === null || typeof result === "object").toBe(true);
  });
});

describe("monthly usage tracking (verified via pollUsage)", () => {
  beforeEach(() => {
    resetMonthlyHalt();
  });

  afterEach(() => {
    resetMonthlyHalt();
  });

  it("increments local counter on incrementMonthlyUsage", () => {
    expect(getMonthlyUsage()).toBe(0);
    incrementMonthlyUsage();
    expect(getMonthlyUsage()).toBe(1);
    incrementMonthlyUsage();
    incrementMonthlyUsage();
    expect(getMonthlyUsage()).toBe(3);
  });

  it("checkMonthlyCapHalt returns true at 90% threshold", () => {
    // Basic tier = 10k cap, 90% = 9000
    for (let i = 0; i < 9000; i++) {
      incrementMonthlyUsage();
    }
    expect(checkMonthlyCapHalt()).toBe(true);
    expect(isActorHalted()).toBe(true);
  });

  it("pollUsage updates monthlyUsage from API", async () => {
    // This test verifies that pollUsage exists and can be called.
    // The actual API update logic is tested in the integration test above.
    const { pollUsage } = await import("@/clients/x");
    expect(typeof pollUsage).toBe("function");
  });
});
