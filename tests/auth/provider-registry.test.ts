import {
  availableAuthModes,
  getProvider,
  listProviders,
  requiresBaseUrl,
} from "@/auth/provider-registry";
import { describe, expect, it } from "vitest";

describe("provider registry", () => {
  it("lists exactly five providers", () => {
    const providers = listProviders();
    expect(providers).toHaveLength(5);
    const ids = providers.map((p) => p.id);
    expect(ids).toEqual(["anthropic", "openai", "xai", "gemini", "openai-compat"]);
  });

  it("every provider has a primary api_key auth mode", () => {
    for (const p of listProviders()) {
      expect(p.primaryAuth.type).toBe("api_key");
    }
  });

  it("anthropic secondary is oauth_external with billing warning", () => {
    const def = getProvider("anthropic");
    expect(def).toBeDefined();
    expect(def?.secondaryAuth).toBeDefined();
    expect(def?.secondaryAuth?.type).toBe("oauth_external");
    expect(def?.secondaryAuth?.hostConstraint).toBe("local_only");
    expect(def?.secondaryAuth?.billingWarning).toContain("extra_usage");
    expect(def?.secondaryAuth?.billingWarning).toContain("hermes-agent issue #12905");
  });

  it("openai secondary is oauth_device_code (works anywhere)", () => {
    const def = getProvider("openai");
    expect(def).toBeDefined();
    expect(def?.secondaryAuth).toBeDefined();
    expect(def?.secondaryAuth?.type).toBe("oauth_device_code");
    expect(def?.secondaryAuth?.hostConstraint).toBe("any");
  });

  it("xai has no secondary auth", () => {
    const def = getProvider("xai");
    expect(def).toBeDefined();
    expect(def?.secondaryAuth).toBeUndefined();
  });

  it("gemini secondary is oauth_external (local only)", () => {
    const def = getProvider("gemini");
    expect(def).toBeDefined();
    expect(def?.secondaryAuth).toBeDefined();
    expect(def?.secondaryAuth?.type).toBe("oauth_external");
    expect(def?.secondaryAuth?.hostConstraint).toBe("local_only");
    expect(def?.secondaryAuth?.billingWarning).toBeUndefined();
  });

  it("openai-compat requires baseUrl", () => {
    expect(requiresBaseUrl("openai-compat")).toBe(true);
    expect(requiresBaseUrl("openai")).toBe(false);
    expect(requiresBaseUrl("anthropic")).toBe(false);
  });

  it("availableAuthModes returns primary + secondary", () => {
    const modes = availableAuthModes("anthropic");
    expect(modes).toHaveLength(2);
    expect(modes[0]?.type).toBe("api_key");
    expect(modes[1]?.type).toBe("oauth_external");
  });

  it("availableAuthModes returns only primary when no secondary", () => {
    const modes = availableAuthModes("xai");
    expect(modes).toHaveLength(1);
    expect(modes[0]?.type).toBe("api_key");
  });

  it("getProvider returns undefined for unknown id", () => {
    expect(getProvider("unknown" as "xai")).toBeUndefined();
  });

  it("all oauth_external modes are local_only (hard constraint #3)", () => {
    for (const p of listProviders()) {
      for (const m of availableAuthModes(p.id)) {
        if (m.type === "oauth_external") {
          expect(m.hostConstraint).toBe("local_only");
        }
      }
    }
  });

  it("api_key and oauth_device_code modes work anywhere (hard constraint #3)", () => {
    for (const p of listProviders()) {
      for (const m of availableAuthModes(p.id)) {
        if (m.type === "api_key" || m.type === "oauth_device_code") {
          expect(m.hostConstraint).toBe("any");
        }
      }
    }
  });
});
