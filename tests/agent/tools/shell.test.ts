import { ShellGateError, makeShellBash } from "@/agent/tools/shell";
import { describe, expect, it } from "vitest";
import { FakeExecutor, makeCtx } from "./helpers";

describe("shell_bash", () => {
  it("delegates to ctx.executor.bash and returns stdout/exitCode", async () => {
    const exec = new FakeExecutor([
      { match: (c) => c === "echo hi", result: { stdout: "hi\n", exitCode: 0 } },
    ]);
    const tool = makeShellBash();
    const ctx = makeCtx({ executor: exec, metadata: { allowShadowBash: true } });
    // gate first, then execute — mimic registry caller
    if (tool.gate) await tool.gate({ command: "echo hi" }, ctx);
    const out = await tool.execute({ command: "echo hi" }, ctx);
    expect(out.stdout).toBe("hi\n");
    expect(out.exitCode).toBe(0);
    expect(out.truncated).toBe(false);
    expect(exec.calls).toHaveLength(1);
  });

  it("throws if no executor is configured", async () => {
    const tool = makeShellBash();
    const ctx = makeCtx({ metadata: { allowShadowBash: true } });
    await expect(tool.execute({ command: "ls" }, ctx)).rejects.toThrow(/no ComputerExecutor/);
  });

  it("gate rejects oversize commands", async () => {
    const tool = makeShellBash();
    const ctx = makeCtx({
      executor: new FakeExecutor(),
      metadata: { allowShadowBash: true },
    });
    const huge = "x".repeat(16 * 1024 + 1);
    expect(() => tool.gate?.({ command: huge }, ctx)).toThrow(ShellGateError);
  });

  it("gate refuses non-live mode unless allowShadowBash", async () => {
    const tool = makeShellBash();
    // In test env STRAND_MODE=shadow. Without the allow-flag, gate should throw.
    const ctx = makeCtx({ executor: new FakeExecutor() });
    expect(() => tool.gate?.({ command: "echo" }, ctx)).toThrow(ShellGateError);
  });
});
