import { DefaultToolRegistry } from "@/agent/registry";
import { registerDefaults } from "@/agent/tools";
import { describe, expect, it } from "vitest";

describe("registerDefaults", () => {
  it("registers the read-only tool set by default", () => {
    const reg = new DefaultToolRegistry();
    registerDefaults(reg);
    const names = reg.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "fs_read",
        "fs_search",
        "shell_bash",
        "http_fetch",
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
        "brain_memory_search",
        "brain_entity_get",
      ]),
    );
    expect(names).not.toContain("fs_write");
    expect(names).not.toContain("git_commit");
  });

  it("adds destructive tools when enableDestructive", () => {
    const reg = new DefaultToolRegistry();
    registerDefaults(reg, { enableDestructive: true });
    const names = reg.list().map((t) => t.name);
    expect(names).toContain("fs_write");
    expect(names).toContain("git_commit");
  });

  it("annotates destructive tools as requiresLive", () => {
    const reg = new DefaultToolRegistry();
    registerDefaults(reg, { enableDestructive: true });
    const commit = reg.get("git_commit");
    expect(commit?.requiresLive).toBe(true);
    expect(commit?.sideEffects).toBe("destructive");
    const bash = reg.get("shell_bash");
    expect(bash?.requiresLive).toBe(true);
  });
});
