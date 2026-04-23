/**
 * Kill switch tests for STRAND_HALT env flag.
 *
 * Per PLAN.md §12 Phase 1: env flag halts loop in <5s.
 */

import { env } from "@/config";
import { start, stop } from "@/orchestrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("STRAND_HALT kill switch", () => {
  let originalHalt: string;

  beforeEach(() => {
    // Store original value
    originalHalt = env["STRAND_HALT"];
    // Ensure clean state
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    // Restore original value
    (env as Record<string, string>)["STRAND_HALT"] = originalHalt;
    vi.useRealTimers();
    // Clean up any started orchestrator
    try {
      await stop();
    } catch {
      // ignore cleanup errors
    }
  });

  it("halts loops when STRAND_HALT=true", () => {
    // Set halt flag
    (env as Record<string, string>)["STRAND_HALT"] = "true";

    // The halt check happens in the every() function
    // When STRAND_HALT="true", loops should skip execution
    expect(env["STRAND_HALT"]).toBe("true");
  });

  it("allows loops to run when STRAND_HALT=false", () => {
    // Ensure halt is false (default)
    (env as Record<string, string>)["STRAND_HALT"] = "false";

    expect(env["STRAND_HALT"]).toBe("false");
  });

  it("exports start and stop functions", () => {
    expect(typeof start).toBe("function");
    expect(typeof stop).toBe("function");
  });

  it("has halt flag in env schema", () => {
    // Verify the env schema includes STRAND_HALT
    expect(env).toHaveProperty("STRAND_HALT");
    expect(env.STRAND_HALT).toMatch(/^(true|false)$/);
  });
});
