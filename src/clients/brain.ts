import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { env } from "@/config";
import { log } from "@/util/log";

/**
 * brainctl wrapper.
 *
 * Two shapes:
 *  - TS-direct: for Perceiver observations + Actor outcomes. Uses a local
 *    MCP stdio transport because we want Grok OUT of these paths.
 *  - Remote MCP tool: built elsewhere (clients/grok.ts) for Grok to call
 *    during reasoning. Those calls never come through here.
 */

let _client: Client | null = null;
let _proc: ChildProcessWithoutNullStreams | null = null;

async function connect(): Promise<Client> {
  if (_client) return _client;

  const cmd = env.BRAINCTL_COMMAND;
  const args = env.BRAINCTL_ARGS.split(/\s+/).filter(Boolean);

  _proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  _proc.stderr.on("data", (b) => log.debug({ svc: "brainctl" }, b.toString()));

  const transport = new StdioClientTransport({
    command: cmd,
    args,
  });
  const client = new Client({ name: "strand", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  _client = client;
  log.info({ svc: "brainctl", cmd, agent: env.BRAINCTL_AGENT_ID }, "brainctl.connected");
  return client;
}

export async function disconnect(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
  if (_proc) {
    _proc.kill();
    _proc = null;
  }
}

async function tool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const c = await connect();
  const result = await c.callTool({ name, arguments: { agent_id: env.BRAINCTL_AGENT_ID, ...args } });
  // MCP returns { content: [{ type: 'text', text: '...' }] } by default.
  // brainctl also returns structured JSON as text — parse leniently.
  const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const first = content.find((c) => c.type === "text" && c.text);
  if (!first?.text) return {} as T;
  try {
    return JSON.parse(first.text) as T;
  } catch {
    return first.text as unknown as T;
  }
}

// ─── Narrow TS-direct API (audit-critical paths only) ────────

export const brain = {
  // Boot
  agent_register: (args: { persona: string; goals: string[] }) =>
    tool("agent_register", args),

  // Beliefs / policies
  belief_seed: (args: { beliefs: Array<{ key: string; value: string }> }) =>
    tool("belief_seed", args),
  policy_add: (args: {
    policy_id: string;
    description: string;
    rule: string;
    priority?: number;
  }) => tool("policy_add", args),
  budget_set: (args: { scope: string; amount: number; unit: string }) =>
    tool("budget_set", args),

  // Perceiver direct writes
  event_add: (args: { kind: string; payload: unknown; entity_refs?: string[] }) =>
    tool<{ event_id: string }>("event_add", args),
  entity_observe: (args: { entity_id?: string; handle?: string; observation: string }) =>
    tool<{ entity_id: string }>("entity_observe", args),
  entity_create: (args: {
    kind: string;
    name: string;
    aliases?: string[];
    attributes?: Record<string, unknown>;
  }) => tool<{ entity_id: string }>("entity_create", args),
  memory_add: (args: {
    text: string;
    tier?: "hot" | "warm" | "cold";
    entity_refs?: string[];
    event_refs?: string[];
  }) => tool<{ memory_id: string }>("memory_add", args),

  // Actor outcome writes
  outcome_annotate: (args: {
    decision_id: string;
    outcome: "success" | "failure" | "partial";
    signals?: Record<string, unknown>;
  }) => tool("outcome_annotate", args),
  policy_feedback: (args: {
    policy_id: string;
    verdict: "approved" | "rejected";
    reasons?: string[];
  }) => tool("policy_feedback", args),
  trust_update_contradiction: (args: { entity_id: string; delta: number; reason: string }) =>
    tool("trust_update_contradiction", args),

  // Health
  health: () => tool<{ ok: boolean }>("health", {}),
};

// ─── Allowlist for Grok remote MCP ───────────────────────────

export const GROK_READ_TOOLS = [
  "memory_search",
  "entity_search",
  "entity_get",
  "event_search",
  "context_search",
  "tom_perspective_get",
  "policy_match",
  "reason",
  "infer_pretask",
  "belief_get",
  "whosknows",
  "vsearch",
  "temporal_context",
  "temporal_causes",
  "temporal_effects",
  "temporal_chain",
];

export const GROK_CONSOLIDATOR_TOOLS = [
  ...GROK_READ_TOOLS,
  "reflexion_write",
  "dream_cycle",
  "consolidation_run",
  "gaps_scan",
  "retirement_analysis",
];
