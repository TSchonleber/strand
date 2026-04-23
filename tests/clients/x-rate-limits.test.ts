import {
  checkMonthlyCapHalt,
  getMonthlyUsage,
  getRateLimit,
  incrementMonthlyUsage,
  isActorHalted,
  parseRateLimitHeaders,
  resetMonthlyHalt,
} from "@/clients/x";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("x client rate limits", () => {
  beforeEach(() => {
    resetMonthlyHalt();
  });

  afterEach(() => {
    resetMonthlyHalt();
  });

  describe("parseRateLimitHeaders", () => {
    it("parses valid headers", () => {
      const headers = {
        "x-rate-limit-limit": "100",
        "x-rate-limit-remaining": "95",
        "x-rate-limit-reset": "1234567890",
      };
      const state = parseRateLimitHeaders(headers, "mentions");
      expect(state).toEqual({
        limit: 100,
        remaining: 95,
        resetAt: 1234567890,
      });
    });

    it("returns null for missing headers", () => {
      const headers = {};
      const state = parseRateLimitHeaders(headers, "mentions");
      expect(state).toBeNull();
    });

    it("stores state for retrieval", () => {
      const headers = {
        "x-rate-limit-limit": "50",
        "x-rate-limit-remaining": "40",
        "x-rate-limit-reset": "1234567890",
      };
      parseRateLimitHeaders(headers, "timeline");
      const retrieved = getRateLimit("timeline");
      expect(retrieved).toEqual({
        limit: 50,
        remaining: 40,
        resetAt: 1234567890,
      });
    });
  });

  describe("monthly usage tracking", () => {
    it("starts at zero", () => {
      expect(getMonthlyUsage()).toBe(0);
    });

    it("increments on each call", () => {
      incrementMonthlyUsage();
      incrementMonthlyUsage();
      expect(getMonthlyUsage()).toBe(2);
    });

    it("resets on resetMonthlyHalt", () => {
      incrementMonthlyUsage();
      expect(getMonthlyUsage()).toBe(1);
      resetMonthlyHalt();
      expect(getMonthlyUsage()).toBe(0);
    });
  });

  describe("monthly cap halt", () => {
    it("does not halt below 90% threshold", () => {
      // basic tier = 10k cap, 90% = 9000
      for (let i = 0; i < 8999; i++) {
        incrementMonthlyUsage();
      }
      expect(checkMonthlyCapHalt()).toBe(false);
      expect(isActorHalted()).toBe(false);
    });

    it("halts at 90% threshold", () => {
      // basic tier = 10k cap, 90% = 9000
      for (let i = 0; i < 9000; i++) {
        incrementMonthlyUsage();
      }
      expect(checkMonthlyCapHalt()).toBe(true);
      expect(isActorHalted()).toBe(true);
    });

    it("stays halted once triggered", () => {
      for (let i = 0; i < 9000; i++) {
        incrementMonthlyUsage();
      }
      checkMonthlyCapHalt();
      expect(checkMonthlyCapHalt()).toBe(true);
    });
  });
});
