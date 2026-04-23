import { DefaultToolRegistry, tools } from "@/agent";
import { describe, expect, it } from "vitest";

describe("registerDefaults brainctl gating", () => {
  it("auto mode: skips brain_* tools when BRAINCTL_COMMAND points at a missing binary", () => {
    const reg = new DefaultToolRegistry();
    const original = process.env["BRAINCTL_COMMAND"];
    process.env["BRAINCTL_COMMAND"] = "/nonexistent/brainctl-xyzzy-does-not-exist";
    try {
      tools.registerDefaults(reg, { brainctl: "auto" });
    } finally {
      if (original === undefined) {
        // biome-ignore lint/performance/noDelete: process.env can't be assigned `undefined` without coercion to "undefined"
        delete process.env["BRAINCTL_COMMAND"];
      } else {
        process.env["BRAINCTL_COMMAND"] = original;
      }
    }
    const names = reg.list().map((t) => t.name);
    expect(names).not.toContain("brain_memory_search");
    expect(names).not.toContain("brain_entity_get");
    // Non-brain defaults still register.
    expect(names).toContain("fs_read");
    expect(names).toContain("http_fetch");
  });

  it("always mode: registers brain_* regardless of PATH", () => {
    const reg = new DefaultToolRegistry();
    const original = process.env["BRAINCTL_COMMAND"];
    process.env["BRAINCTL_COMMAND"] = "/nonexistent/brainctl-xyzzy";
    try {
      tools.registerDefaults(reg, { brainctl: "always" });
    } finally {
      if (original === undefined) {
        // biome-ignore lint/performance/noDelete: process.env can't be assigned `undefined` without coercion to "undefined"
        delete process.env["BRAINCTL_COMMAND"];
      } else {
        process.env["BRAINCTL_COMMAND"] = original;
      }
    }
    const names = reg.list().map((t) => t.name);
    expect(names).toContain("brain_memory_search");
    expect(names).toContain("brain_entity_get");
  });

  it("never mode: suppresses brain_* even when PATH has brainctl", () => {
    const reg = new DefaultToolRegistry();
    tools.registerDefaults(reg, { brainctl: "never" });
    const names = reg.list().map((t) => t.name);
    expect(names).not.toContain("brain_memory_search");
    expect(names).not.toContain("brain_entity_get");
  });
});
