import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAllExternalCredentials,
  discoverClaudeCodeCredentials,
  discoverGeminiCliCredentials,
} from "@/auth/external-discovery";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function tmpHome(): string {
  const dir = join(
    tmpdir(),
    `strand-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("external credential discovery", () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });

  afterEach(() => {
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  describe("Claude Code credentials", () => {
    it("returns found=false when file does not exist", () => {
      const result = discoverClaudeCodeCredentials(home);
      expect(result.found).toBe(false);
      expect(result.localOnly).toBe(true);
    });

    it("discovers oauthAccessToken from credentials file", () => {
      const credDir = join(home, ".claude");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(
        join(credDir, ".credentials.json"),
        JSON.stringify({ oauthAccessToken: "claude-token-abc" }),
      );

      const result = discoverClaudeCodeCredentials(home);
      expect(result.found).toBe(true);
      expect(result.token).toBe("claude-token-abc");
      expect(result.localOnly).toBe(true);
    });

    it("falls back to accessToken field", () => {
      const credDir = join(home, ".claude");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(
        join(credDir, ".credentials.json"),
        JSON.stringify({ accessToken: "fallback-token" }),
      );

      const result = discoverClaudeCodeCredentials(home);
      expect(result.found).toBe(true);
      expect(result.token).toBe("fallback-token");
    });

    it("always includes billing warning when found (hard constraint #4)", () => {
      const credDir = join(home, ".claude");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(
        join(credDir, ".credentials.json"),
        JSON.stringify({ oauthAccessToken: "tok" }),
      );

      const result = discoverClaudeCodeCredentials(home);
      expect(result.billingWarning).toBeDefined();
      expect(result.billingWarning).toContain("extra_usage");
      expect(result.billingWarning).toContain("hermes-agent issue #12905");
    });

    it("returns found=false for empty token", () => {
      const credDir = join(home, ".claude");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(join(credDir, ".credentials.json"), JSON.stringify({ accessToken: "" }));

      const result = discoverClaudeCodeCredentials(home);
      expect(result.found).toBe(false);
    });

    it("returns found=false for corrupt JSON", () => {
      const credDir = join(home, ".claude");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(join(credDir, ".credentials.json"), "not json");

      const result = discoverClaudeCodeCredentials(home);
      expect(result.found).toBe(false);
    });
  });

  describe("Gemini CLI credentials", () => {
    it("returns found=false when no files exist", () => {
      const result = discoverGeminiCliCredentials(home);
      expect(result.found).toBe(false);
      expect(result.localOnly).toBe(true);
    });

    it("discovers from gemini-cli path", () => {
      const credDir = join(home, ".config", "gemini-cli");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(
        join(credDir, "oauth_creds.json"),
        JSON.stringify({ access_token: "gemini-tok" }),
      );

      const result = discoverGeminiCliCredentials(home);
      expect(result.found).toBe(true);
      expect(result.token).toBe("gemini-tok");
      expect(result.localOnly).toBe(true);
    });

    it("discovers from qwen fallback path", () => {
      const credDir = join(home, ".qwen");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(
        join(credDir, "oauth_creds.json"),
        JSON.stringify({ access_token: "qwen-tok" }),
      );

      const result = discoverGeminiCliCredentials(home);
      expect(result.found).toBe(true);
      expect(result.token).toBe("qwen-tok");
    });

    it("no billing warning for Gemini", () => {
      const credDir = join(home, ".config", "gemini-cli");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(join(credDir, "oauth_creds.json"), JSON.stringify({ access_token: "tok" }));

      const result = discoverGeminiCliCredentials(home);
      expect(result.billingWarning).toBeUndefined();
    });
  });

  describe("discoverAllExternalCredentials", () => {
    it("runs both probes", () => {
      const results = discoverAllExternalCredentials(home);
      expect(results.anthropic.found).toBe(false);
      expect(results.gemini.found).toBe(false);
    });

    it("finds both when credentials exist", () => {
      const claudeDir = join(home, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({ oauthAccessToken: "claude-tok" }),
      );

      const geminiDir = join(home, ".config", "gemini-cli");
      mkdirSync(geminiDir, { recursive: true });
      writeFileSync(
        join(geminiDir, "oauth_creds.json"),
        JSON.stringify({ access_token: "gemini-tok" }),
      );

      const results = discoverAllExternalCredentials(home);
      expect(results.anthropic.found).toBe(true);
      expect(results.gemini.found).toBe(true);
    });
  });
});
