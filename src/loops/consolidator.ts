import { randomUUID } from "node:crypto";
import { GROK_CONSOLIDATOR_TOOLS } from "@/clients/brain";
import {
  type GrokCallInput,
  type GrokTool,
  brainctlMcpTool,
  buildBatchRequestLine,
  buildResponsesBody,
  grokBatchCreate,
  grokBatchGet,
  grokBatchResults,
  grokFilesUpload,
} from "@/clients/grok";
import { env } from "@/config";
import { db } from "@/db";
import { loadPrompt } from "@/prompts";
import { loopLog } from "@/util/log";

const log = loopLog("consolidator");

/**
 * Nightly consolidation via xAI Batch API (50% off all token classes).
 *
 * `consolidatorRun` builds a ~5-line JSONL, uploads it, creates the batch, and
 * records a `consolidator_runs` row with status='queued'. Polling/result
 * aggregation is `consolidatorPoll` — orchestrator should wire it separately
 * (every ~30 min during the 24h SLA window).
 *
 * Deferred Completions is Chat-Completions-only and is NOT a valid fallback.
 * If the Batch API is down we halt; no synchronous /v1/responses fallback here.
 */

type TaskId =
  | "dream_cycle"
  | "consolidation_run"
  | "gaps_scan"
  | "retirement_analysis"
  | "reflexion_write";

interface ConsolidationTask {
  id: TaskId;
  instruction: string;
}

const TASKS: ConsolidationTask[] = [
  {
    id: "dream_cycle",
    instruction:
      "Call brainctl.dream_cycle to run the nightly dream pass. Summarize what it changed in `changed`; put any surprising patterns in `insights`.",
  },
  {
    id: "consolidation_run",
    instruction:
      "Call brainctl.consolidation_run and report what consolidated. Populate `changed` with a concise list of what moved tier/shape; surface any duplicate-memory signal in `insights`.",
  },
  {
    id: "gaps_scan",
    instruction:
      "Call brainctl.gaps_scan. Return up to 10 of the most load-bearing gaps in `gaps`. Do not propose how to resolve them.",
  },
  {
    id: "retirement_analysis",
    instruction:
      "Call brainctl.retirement_analysis. Apply the conservative rule from the system prompt: only add to `retirements` if utility is clearly low AND no reference in last 14 days AND not policy/decision/identity. Otherwise move marginal candidates to `gaps` as a question.",
  },
  {
    id: "reflexion_write",
    instruction:
      "Read recent policy_feedback via brainctl.memory_search and temporal_context, then call brainctl.reflexion_write to synthesize one reflexion over the last 24h. Note the reflexion id/summary in `changed` and any pattern you observed in `insights`.",
  },
];

const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["changed", "insights", "gaps", "retirements"],
  properties: {
    changed: { type: "array", items: { type: "string" } },
    insights: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
    retirements: { type: "array", items: { type: "string" } },
  },
};

const PROMPT_CACHE_KEY = "strand:consolidator:v1";

interface AggregatedSummary {
  changed: string[];
  insights: string[];
  gaps: string[];
  retirements: string[];
  failed_tasks: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildTools(): GrokTool[] {
  const tools: GrokTool[] = [];
  if (env.BRAINCTL_REMOTE_MCP_URL) {
    tools.push(
      brainctlMcpTool({
        url: env.BRAINCTL_REMOTE_MCP_URL,
        ...(env.BRAINCTL_REMOTE_MCP_TOKEN ? { token: env.BRAINCTL_REMOTE_MCP_TOKEN } : {}),
        allowedTools: GROK_CONSOLIDATOR_TOOLS,
      }),
    );
  }
  return tools;
}

function buildJsonl(): string {
  const prompt = loadPrompt("consolidator.system");
  const tools = buildTools();

  const lines: string[] = [];
  for (const task of TASKS) {
    const callInput: GrokCallInput = {
      model: env.GROK_MODEL_REASONER,
      systemPrompts: [
        `# consolidator\n${prompt.content}`,
        `# prompt_versions: consolidator=${prompt.hash}`,
      ],
      userInput: `Task: ${task.id}\n\n${task.instruction}\n\nReturn ONLY the JSON summary.`,
      maxOutputTokens: 2000,
      maxTurns: 5,
      promptCacheKey: PROMPT_CACHE_KEY,
      include: ["mcp_call_output", "reasoning.encrypted_content"],
      responseSchema: {
        name: "consolidator_summary",
        schema: SUMMARY_SCHEMA,
        strict: true,
      },
    };
    if (tools.length > 0) callInput.tools = tools;
    const body = buildResponsesBody(callInput);
    lines.push(
      buildBatchRequestLine({
        customId: `consolidator:${task.id}`,
        url: "/v1/responses",
        body,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface ConsolidatorRunResult {
  runId: string;
  batchId: string;
}

/**
 * Build JSONL → upload → create batch → insert row. No polling.
 *
 * Returns `void` for orchestrator's setInterval signature; the runId + batchId
 * are available via `consolidatorRunWithResult` for callers that need them
 * (tests, scripts).
 */
export async function consolidatorRun(): Promise<void> {
  await consolidatorRunWithResult();
}

export async function consolidatorRunWithResult(): Promise<ConsolidatorRunResult> {
  const t0 = Date.now();
  const runId = randomUUID();

  const jsonl = buildJsonl();
  const { id: fileId } = await grokFilesUpload(jsonl, "batch");
  const batch = await grokBatchCreate({
    inputFileId: fileId,
    endpoint: "/v1/responses",
    completionWindow: "24h",
  });

  db()
    .prepare(
      `INSERT INTO consolidator_runs (id, batch_id, status, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(runId, batch.id, "queued", nowIso());

  log.info(
    {
      runId,
      batchId: batch.id,
      fileId,
      taskCount: TASKS.length,
      durationMs: Date.now() - t0,
    },
    "consolidator.run.submitted",
  );

  return { runId, batchId: batch.id };
}

/**
 * Poll open batches, update rows in consolidator_runs, aggregate summaries on
 * completion. Safe to call repeatedly (idempotent per-row).
 */
export async function consolidatorPoll(): Promise<void> {
  const openRows = db()
    .prepare(
      `SELECT id, batch_id, status FROM consolidator_runs
       WHERE status IN ('queued','in_progress','validating','finalizing')`,
    )
    .all() as Array<{ id: string; batch_id: string; status: string }>;

  if (openRows.length === 0) {
    log.debug({}, "consolidator.poll.nothing_open");
    return;
  }

  for (const row of openRows) {
    try {
      const batch = await grokBatchGet(row.batch_id);

      if (batch.status === "completed") {
        const summary = await aggregateResults(row.batch_id);
        db()
          .prepare(
            `UPDATE consolidator_runs
             SET status = ?, completed_at = ?, summary_json = ?, error = NULL
             WHERE id = ?`,
          )
          .run("completed", nowIso(), JSON.stringify(summary), row.id);
        log.info(
          {
            runId: row.id,
            batchId: row.batch_id,
            counts: {
              changed: summary.changed.length,
              insights: summary.insights.length,
              gaps: summary.gaps.length,
              retirements: summary.retirements.length,
              failed: summary.failed_tasks.length,
            },
          },
          "consolidator.poll.completed",
        );
      } else if (
        batch.status === "failed" ||
        batch.status === "expired" ||
        batch.status === "cancelled"
      ) {
        const errMsg = `batch ${batch.status} (counts=${JSON.stringify(batch.request_counts ?? {})})`;
        db()
          .prepare(
            `UPDATE consolidator_runs
             SET status = ?, completed_at = ?, error = ?
             WHERE id = ?`,
          )
          .run("failed", nowIso(), errMsg, row.id);
        log.error(
          { runId: row.id, batchId: row.batch_id, status: batch.status },
          "consolidator.poll.failed",
        );
      } else {
        // validating / in_progress / finalizing / cancelling — keep polling.
        const next = batch.status === "finalizing" ? "finalizing" : batch.status;
        if (next !== row.status) {
          db().prepare("UPDATE consolidator_runs SET status = ? WHERE id = ?").run(next, row.id);
        }
        log.debug(
          { runId: row.id, batchId: row.batch_id, status: batch.status },
          "consolidator.poll.pending",
        );
      }
    } catch (err) {
      log.error({ err, runId: row.id, batchId: row.batch_id }, "consolidator.poll.error");
    }
  }
}

/**
 * Stream results, parse each line's response.body.output_text as a summary
 * JSON object, aggregate into a single bag. Errored lines go into `failed_tasks`.
 */
async function aggregateResults(batchId: string): Promise<AggregatedSummary> {
  const out: AggregatedSummary = {
    changed: [],
    insights: [],
    gaps: [],
    retirements: [],
    failed_tasks: [],
  };

  const iter = await grokBatchResults(batchId);
  for await (const line of iter) {
    if (line.error) {
      out.failed_tasks.push(`${line.custom_id}: ${line.error.code} ${line.error.message}`);
      log.warn(
        { batchId, customId: line.custom_id, code: line.error.code, message: line.error.message },
        "consolidator.line.error",
      );
      continue;
    }
    const body = line.response?.body;
    if (!body) {
      out.failed_tasks.push(`${line.custom_id}: no response body`);
      continue;
    }
    const outputText = extractOutputText(body);
    if (!outputText) {
      out.failed_tasks.push(`${line.custom_id}: no output_text`);
      continue;
    }
    try {
      const parsed = JSON.parse(outputText) as Partial<AggregatedSummary>;
      if (Array.isArray(parsed.changed)) out.changed.push(...parsed.changed);
      if (Array.isArray(parsed.insights)) out.insights.push(...parsed.insights);
      if (Array.isArray(parsed.gaps)) out.gaps.push(...parsed.gaps);
      if (Array.isArray(parsed.retirements)) out.retirements.push(...parsed.retirements);
    } catch (err) {
      out.failed_tasks.push(`${line.custom_id}: parse_failed`);
      log.warn({ err, customId: line.custom_id }, "consolidator.line.parse_failed");
    }
  }

  return out;
}

function extractOutputText(body: Record<string, unknown>): string | null {
  const direct = body["output_text"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  // Responses API: body.output is an array; concatenate text parts of message items.
  const output = body["output"];
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (rec["type"] !== "message") continue;
      const content = rec["content"];
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (typeof c !== "object" || c === null) continue;
        const cc = c as Record<string, unknown>;
        const text = cc["text"];
        if (typeof text === "string") parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  return null;
}
