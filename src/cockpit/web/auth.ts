import { randomBytes, timingSafeEqual } from "node:crypto";

export const COCKPIT_TOKEN_HEADER = "X-Cockpit-Token";
export const COCKPIT_TOKEN_BYTES = 32;

export function generateCockpitToken(): string {
  return randomBytes(COCKPIT_TOKEN_BYTES).toString("hex");
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr === "localhost"
  );
}

export function verifyToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}
