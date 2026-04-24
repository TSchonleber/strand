import {
  COCKPIT_TOKEN_BYTES,
  COCKPIT_TOKEN_HEADER,
  generateCockpitToken,
  isLoopbackAddress,
  verifyToken,
} from "@/cockpit/web/auth";
import { describe, expect, it } from "vitest";

describe("cockpit web auth", () => {
  it("generates tokens of correct length", () => {
    const token = generateCockpitToken();
    expect(typeof token).toBe("string");
    expect(token).toHaveLength(COCKPIT_TOKEN_BYTES * 2); // hex encoding
  });

  it("generates unique tokens each time", () => {
    const a = generateCockpitToken();
    const b = generateCockpitToken();
    expect(a).not.toBe(b);
  });

  it("verifies matching tokens", () => {
    const token = generateCockpitToken();
    expect(verifyToken(token, token)).toBe(true);
  });

  it("rejects mismatched tokens", () => {
    const a = generateCockpitToken();
    const b = generateCockpitToken();
    expect(verifyToken(a, b)).toBe(false);
  });

  it("rejects null/undefined/empty tokens", () => {
    const token = generateCockpitToken();
    expect(verifyToken(null, token)).toBe(false);
    expect(verifyToken(undefined, token)).toBe(false);
    expect(verifyToken("", token)).toBe(false);
  });

  it("rejects tokens of different length", () => {
    const token = generateCockpitToken();
    expect(verifyToken(token.slice(0, 10), token)).toBe(false);
    expect(verifyToken(`${token}extra`, token)).toBe(false);
  });

  it("identifies loopback addresses correctly", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
  });

  it("rejects non-loopback addresses", () => {
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("example.com")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("exports the correct header name", () => {
    expect(COCKPIT_TOKEN_HEADER).toBe("X-Cockpit-Token");
  });
});
