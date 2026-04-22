/**
 * Strand welcome splash — the default `strand tui` view.
 *
 * Pure-static, no polling. Shows:
 *   - a big STRAND banner (ink-big-text + ink-gradient)
 *   - a subtitle with provider / mode / version / credential store
 *   - two columns: COMMANDS (curated) and TOOLS (from the registry)
 *   - a one-line keyboard hint
 *
 * The dashboard (active graphs + tool stream) lives behind
 * `strand tui --dashboard`.
 */

import { env } from "@/config";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import type { ReactElement } from "react";
import { version } from "./version";

export interface WelcomeEntry {
  name: string;
  description: string;
}

export interface WelcomeProps {
  commands: WelcomeEntry[];
  tools: WelcomeEntry[];
  onDashboard?: () => void;
}

const COMMAND_NAME_WIDTH = 14;
const TOOL_NAME_WIDTH = 18;
const DESC_MAX_WIDTH = 22;

export function Welcome({ commands, tools, onDashboard }: WelcomeProps): ReactElement {
  const app = useApp();
  const { isRawModeSupported } = useStdin();
  const store = process.env["STRAND_CREDENTIAL_STORE"] ?? "env";
  const tenant = process.env["STRAND_TENANT"] ?? null;

  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        app.exit();
        return;
      }
      if (input === "d" && onDashboard) {
        onDashboard();
      }
    },
    { isActive: Boolean(isRawModeSupported) },
  );

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Banner */}
      <Box justifyContent="center">
        <Gradient name="pastel">
          <BigText text="STRAND" font="block" />
        </Gradient>
      </Box>

      {/* Subtitle */}
      <Box justifyContent="center" marginTop={-1}>
        <Text dimColor>agent harness · v{version}</Text>
      </Box>
      <Box justifyContent="center">
        <Text color="gray">
          {env.LLM_PROVIDER}/{env.LLM_MODEL_REASONER} · mode={env.STRAND_MODE} · store={store}
          {tenant ? ` · tenant=${tenant}` : ""}
        </Text>
      </Box>

      {/* Two-column layout — every row is pre-padded to fixed width so Ink's
          flex layout never pushes the right column into the left. */}
      <Box marginTop={2} flexDirection="row">
        <Box flexDirection="column" marginRight={2}>
          <Text bold color="cyan">
            ─── COMMANDS ───
          </Text>
          <Box marginTop={1} />
          {commands.map((c) => (
            <Text key={c.name}>
              <Text color="yellow">
                {pad(truncate(c.name, COMMAND_NAME_WIDTH), COMMAND_NAME_WIDTH + 1)}
              </Text>
              <Text dimColor>{pad(truncate(c.description, DESC_MAX_WIDTH), DESC_MAX_WIDTH)}</Text>
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold color="magenta">
            ─── TOOLS ───
          </Text>
          <Box marginTop={1} />
          {tools.map((t) => (
            <Text key={t.name}>
              <Text color="cyan">
                {pad(truncate(t.name, TOOL_NAME_WIDTH), TOOL_NAME_WIDTH + 1)}
              </Text>
              <Text dimColor>{pad(truncate(t.description, DESC_MAX_WIDTH), DESC_MAX_WIDTH)}</Text>
            </Text>
          ))}
        </Box>
      </Box>

      {/* Footer hint */}
      <Box marginTop={2} justifyContent="center">
        {isRawModeSupported ? (
          <Text dimColor>
            [<Text color="white">d</Text>] dashboard · [<Text color="white">q</Text>] quit
          </Text>
        ) : (
          <Text dimColor>non-TTY · run in a real terminal for keyboard shortcuts</Text>
        )}
      </Box>
    </Box>
  );
}

// ─── Curated command catalog ───────────────────────────────────────────────

export const DEFAULT_COMMANDS: WelcomeEntry[] = [
  { name: "run <goal>", description: "one-shot agentic plan" },
  { name: "tui", description: "this welcome (+ --dashboard)" },
  { name: "status", description: "orchestrator + runs summary" },
  { name: "tasks", description: "inspect persisted task graphs" },
  { name: "budget", description: "spend + limits" },
  { name: "cache", description: "prompt-cache hit rates" },
  { name: "tools list", description: "show registered tools" },
  { name: "keys", description: "credential CRUD" },
  { name: "oauth x", description: "X OAuth 2.0 PKCE flow" },
  { name: "config show", description: "effective config" },
  { name: "config validate", description: "validate a config file" },
  { name: "dev", description: "boot orchestrator (watch)" },
  { name: "smoke", description: "integration smoke" },
  { name: "review", description: "approve/reject review queue" },
];

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}
