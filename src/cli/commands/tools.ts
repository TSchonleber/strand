import type { Command } from "commander";
import type { CliContext } from "../index";
import { printTable, truncate } from "../util/output";

export function registerToolsCmd(program: Command, _ctx: CliContext): void {
  const toolsCmd = program.command("tools").description("inspect the built-in tool registry");

  toolsCmd
    .command("list")
    .description("list registered default tools")
    .option("--enable-destructive", "include destructive tools (fs_write, git_commit)")
    .action(async (opts: { enableDestructive?: boolean }) => {
      const { DefaultToolRegistry, tools } = await import("@/agent");
      const reg = new DefaultToolRegistry();
      // Force `brainctl: "always"` so the catalog is stable regardless of whether
      // the `brainctl` binary is on PATH on this machine. Actual plan runs use
      // `"auto"` and silently skip brain_* when the binary is missing.
      tools.registerDefaults(reg, {
        enableDestructive: opts.enableDestructive === true,
        brainctl: "always",
      });
      const all = reg.list();
      printTable(all, [
        { header: "name", value: (t) => t.name, maxWidth: 24 },
        { header: "sideEffects", value: (t) => t.sideEffects ?? "none", maxWidth: 12 },
        { header: "description", value: (t) => truncate(t.description, 80), maxWidth: 80 },
      ]);
    });
}
