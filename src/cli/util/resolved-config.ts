import type { Command } from "commander";
import { type ResolvedConfig, loadConfig } from "../config";

/**
 * Walk up the commander parent chain looking for `_resolvedConfig` stashed
 * by the preAction hook on the program root. Falls back to re-running
 * `loadConfig()` if the hook didn't run (e.g., a nested subcommand was
 * invoked directly in tests).
 */
export function getResolvedConfig(cmd: Command): ResolvedConfig {
  let node: Command | null = cmd;
  while (node) {
    const candidate = node as unknown as { _resolvedConfig?: ResolvedConfig };
    if (candidate._resolvedConfig) return candidate._resolvedConfig;
    node = node.parent;
  }
  return loadConfig({ silent: true });
}
