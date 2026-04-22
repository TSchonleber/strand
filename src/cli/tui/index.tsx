/**
 * TUI entry — routes between the Welcome splash and the live Dashboard.
 *
 *   strand tui                    → Welcome (default)
 *   strand tui --dashboard        → Dashboard (live active graphs + stream)
 *
 * Both views respect raw-mode detection so they don't crash in pipes.
 */

import { DefaultToolRegistry } from "@/agent/registry";
import { registerDefaults } from "@/agent/tools";
import { render } from "ink";
import type { ReactElement } from "react";
import { useState } from "react";
import { Dashboard } from "./dashboard";
import { DataSourceContext, type TuiDataSource, makeSqliteDataSource } from "./hooks";
import { DEFAULT_COMMANDS, Welcome, type WelcomeEntry, truncate } from "./welcome";

// Re-export for tests + subcommands that want to render directly.
export { Dashboard, Welcome };
export type { DashboardProps } from "./dashboard";
export type { WelcomeEntry, WelcomeProps } from "./welcome";

export interface LaunchTuiOpts {
  /** Start on the dashboard instead of the welcome splash. */
  dashboard?: boolean;
  /** Dashboard poll cadence in ms. */
  pollMs?: number;
  /** Test hook: inject a stub data source instead of opening SQLite. */
  dataSource?: TuiDataSource;
  /** Test hook: override the tool list instead of importing the registry. */
  tools?: WelcomeEntry[];
}

function loadTools(): WelcomeEntry[] {
  try {
    const registry = new DefaultToolRegistry();
    registerDefaults(registry);
    return registry.list().map((t) => ({ name: t.name, description: truncate(t.description, 48) }));
  } catch {
    return [];
  }
}

function Router({
  startMode,
  pollMs,
  tools,
}: {
  startMode: "welcome" | "dashboard";
  pollMs: number;
  tools: WelcomeEntry[];
}): ReactElement {
  const [mode, setMode] = useState<"welcome" | "dashboard">(startMode);

  if (mode === "dashboard") {
    return <Dashboard pollMs={pollMs} onWelcome={() => setMode("welcome")} />;
  }
  return (
    <Welcome commands={DEFAULT_COMMANDS} tools={tools} onDashboard={() => setMode("dashboard")} />
  );
}

export async function launchTui(opts: LaunchTuiOpts = {}): Promise<void> {
  const source = opts.dataSource ?? makeSqliteDataSource();
  const tools = opts.tools ?? loadTools();
  const instance = render(
    <DataSourceContext.Provider value={source}>
      <Router
        startMode={opts.dashboard ? "dashboard" : "welcome"}
        pollMs={opts.pollMs ?? 2000}
        tools={tools}
      />
    </DataSourceContext.Provider>,
  );
  await instance.waitUntilExit();
}
