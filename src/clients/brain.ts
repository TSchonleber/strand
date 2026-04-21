import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { env } from "@/config";
import { log } from "@/util/log";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  const result = await c.callTool({
    name,
    arguments: { agent_id: env.BRAINCTL_AGENT_ID, ...args },
  });
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

export interface ReadOp {
  tool: string;
  args: unknown;
}

export type BatchReadResult = { ok: true; value: unknown } | { ok: false; error: string };

const BATCH_READ_TIMEOUT_MS = 5000;

async function callToolWithTimeout(
  name: string,
  args: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    // Unref so a lingering timer never blocks process exit.
    t.unref?.();
  });
  const call = tool<unknown>(name, (args as Record<string, unknown>) ?? {});
  return Promise.race([call, timeoutPromise]);
}

export const brain = {
  // Boot
  agent_register: (args: { persona: string; goals: string[] }) => tool("agent_register", args),

  // Beliefs / policies
  belief_seed: (args: { beliefs: Array<{ key: string; value: string }> }) =>
    tool("belief_seed", args),
  belief_set: (args: { key: string; value: unknown; scope?: string }) => tool("belief_set", args),
  policy_add: (args: {
    policy_id: string;
    description: string;
    rule: string;
    priority?: number;
  }) => tool("policy_add", args),
  budget_set: (args: { scope: string; amount: number; unit: string }) => tool("budget_set", args),

  // Perceiver direct writes
  event_add: (args: { kind: string; payload: unknown; entity_refs?: string[] }) =>
    tool<{ event_id: string }>("event_add", args),
  entity_observe: (args: {
    entity_id?: string;
    identifier?: string;
    handle?: string;
    observation?: string;
    observations?: string;
  }) => tool<{ entity_id: string }>("entity_observe", args),
  entity_create: (args: {
    kind: string;
    name: string;
    aliases?: string[];
    attributes?: Record<string, unknown>;
  }) => tool<{ entity_id: string }>("entity_create", args),
  entity_merge: (args: { from_ids: string[]; into_id: string }) =>
    tool<{ merged: number }>("entity_merge", args),
  memory_add: (args: {
    text: string;
    tier?: "hot" | "warm" | "cold";
    entity_refs?: string[];
    event_refs?: string[];
  }) => tool<{ memory_id: string }>("memory_add", args),
  memory_promote: (args: { id: string }) => tool<{ promoted: boolean }>("memory_promote", args),

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
  trust_calibrate: (args: { memory_id: string; outcome: "success" | "failure" | "partial" }) =>
    tool("trust_calibrate", args),

  // TS-direct read helpers. Grok has its own copies via MCP allowlist; these
  // are for scripts (replay, audits) that bypass Grok entirely.
  context_search: (args: { query: string; limit?: number }) =>
    tool<{ results: unknown[] }>("context_search", args),
  temporal_map: (args: { since?: string }) => tool<{ map: unknown }>("temporal_map", args),
  memory_search: (args: { query: string; limit?: number; scope?: string; tier?: string }) =>
    tool<{ results: unknown[] }>("memory_search", args),
  entity_get: (args: { entity_id?: string; identifier?: string; handle?: string }) =>
    tool<{ entity: unknown }>("entity_get", args),

  // Batched concurrent read helper. Each op gets a 5s timeout; failures
  // surface per-op so partial results are still actionable.
  async batchReads(ops: ReadOp[]): Promise<BatchReadResult[]> {
    const settled = await Promise.allSettled(
      ops.map((op) => callToolWithTimeout(op.tool, op.args, BATCH_READ_TIMEOUT_MS)),
    );
    return settled.map((s): BatchReadResult => {
      if (s.status === "fulfilled") return { ok: true, value: s.value };
      const reason = s.reason;
      const msg =
        reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "error";
      return { ok: false, error: msg };
    });
  },

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
