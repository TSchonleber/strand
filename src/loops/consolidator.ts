import { randomUUID } from "node:crypto";
import { GROK_CONSOLIDATOR_TOOLS } from "@/clients/brain";
import { brainctlMcpTool } from "@/clients/grok";
import { hasBatch, llm } from "@/clients/llm";
import type { LlmCall, LlmMcpTool, LlmTool } from "@/clients/llm/types";
import { env } from "@/config";
import { db } from "@/db";
import { loadPrompt } from "@/prompts";
import { loopLog } from "@/util/log";

const log = loopLog("consolidator");

/**
 * Nightly consolidation — provider-agnostic.
 *
 * When the active provider supports Batch (xAI, OpenAI), we build a JSONL of
 * per-task requests via `provider.buildBatchLine()`, upload + create a batch,
 * and insert a `consolidator_runs` row at status=queued. `consolidatorPoll`
 * drives it to completion.
 *
 * When the provider does NOT support Batch (Anthropic, Gemini as of v1), we
 * fall back to running each task synchronously via `provider.chat()` and
 * record the aggregated summary directly — status=completed, batch_id
 * `local:<uuid>` so the poll path skips it.
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

function buildTools(): LlmTool[] {
  const tools: LlmTool[] = [];
  if (env.BRAINCTL_REMOTE_MCP_URL) {
    // `brainctlMcpTool` returns a GrokTool with `type:"mcp"`; the shape is
    // 1:1 with LlmMcpTool, so we widen the type here. Non-MCP providers drop
    // it with a warn per their adapter's partitioning rules.
    tools.push(
      brainctlMcpTool({
        url: env.BRAINCTL_REMOTE_MCP_URL,
        ...(env.BRAINCTL_REMOTE_MCP_TOKEN ? { token: env.BRAINCTL_REMOTE_MCP_TOKEN } : {}),
        allowedTools: GROK_CONSOLIDATOR_TOOLS,
      }) as unknown as LlmMcpTool,
    );
  }
  return tools;
}

function taskToLlmCall(task: ConsolidationTask): LlmCall {
  const prompt = loadPrompt("consolidator.system");
  const tools = buildTools();

  const call: LlmCall = {
    model: env.LLM_MODEL_REASONER,
    messages: [
      { role: "system", content: `# consolidator\n${prompt.content}` },
      { role: "system", content: `# prompt_versions: consolidator=${prompt.hash}` },
      {
        role: "user",
        content: `Task: ${task.id}\n\n${task.instruction}\n\nReturn ONLY the JSON summary.`,
      },
    ],
    maxOutputTokens: 2000,
    maxTurns: 5,
    promptCacheKey: PROMPT_CACHE_KEY,
    include: ["mcp_call_output", "reasoning.encrypted_content"],
    structuredOutput: {
      name: "consolidator_summary",
      schema: SUMMARY_SCHEMA,
      strict: true,
    },
  };
  if (tools.length > 0) call.tools = tools;
  return call;
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
  const provider = llm();

  if (hasBatch(provider) && typeof provider.buildBatchLine === "function") {
    const buildLine = provider.buildBatchLine.bind(provider);
    const lines: string[] = [];
    for (const task of TASKS) {
      const line = buildLine(taskToLlmCall(task), `consolidator:${task.id}`);
      lines.push(JSON.stringify(line));
    }
    const jsonl = `${lines.join("\n")}\n`;

    const { id: fileId } = await provider.filesUpload(jsonl, "batch");
    const batch = await provider.batchCreate({
      inputFileId: fileId,
      endpoint: provider.name === "xai" ? "/v1/responses" : "/v1/chat/completions",
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
        provider: provider.name,
        taskCount: TASKS.length,
        durationMs: Date.now() - t0,
      },
      "consolidator.run.submitted",
    );

    return { runId, batchId: batch.id };
  }

  // Sync fallback — provider has no Batch API.
  log.warn({ provider: provider.name }, "consolidator.batch_not_supported.sync_fallback");

  const summary: AggregatedSummary = {
    changed: [],
    insights: [],
    gaps: [],
    retirements: [],
    failed_tasks: [],
  };

  for (const task of TASKS) {
    try {
      const res = await provider.chat<Partial<AggregatedSummary>>(taskToLlmCall(task));
      const parsed: Partial<AggregatedSummary> | null =
        res.parsed ??
        (res.outputText ? safeJsonParse<Partial<AggregatedSummary>>(res.outputText) : null);
      if (!parsed) {
        summary.failed_tasks.push(`consolidator:${task.id}: no parseable summary`);
        continue;
      }
      if (Array.isArray(parsed.changed)) summary.changed.push(...parsed.changed);
      if (Array.isArray(parsed.insights)) summary.insights.push(...parsed.insights);
      if (Array.isArray(parsed.gaps)) summary.gaps.push(...parsed.gaps);
      if (Array.isArray(parsed.retirements)) summary.retirements.push(...parsed.retirements);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.failed_tasks.push(`consolidator:${task.id}: ${msg}`);
      log.warn({ err, task: task.id }, "consolidator.sync.task_failed");
    }
  }

  const localBatchId = `local:${randomUUID()}`;
  db()
    .prepare(
      `INSERT INTO consolidator_runs (id, batch_id, status, created_at, completed_at, summary_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, localBatchId, "completed", nowIso(), nowIso(), JSON.stringify(summary));

  log.info(
    {
      runId,
      batchId: localBatchId,
      provider: provider.name,
      taskCount: TASKS.length,
      counts: {
        changed: summary.changed.length,
        insights: summary.insights.length,
        gaps: summary.gaps.length,
        retirements: summary.retirements.length,
        failed: summary.failed_tasks.length,
      },
      durationMs: Date.now() - t0,
    },
    "consolidator.run.sync_completed",
  );

  return { runId, batchId: localBatchId };
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Poll open batches, update rows in consolidator_runs, aggregate summaries on
 * completion. Safe to call repeatedly (idempotent per-row).
 *
 * Rows with `batch_id` starting with `local:` are never returned by the
 * open-row query (they're inserted at status=completed). Still a no-op for
 * the sync-fallback path.
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

  const provider = llm();
  if (!hasBatch(provider)) {
    log.warn(
      { provider: provider.name, openRows: openRows.length },
      "consolidator.poll.provider_has_no_batch",
    );
    return;
  }

  for (const row of openRows) {
    try {
      const batch = await provider.batchGet(row.batch_id);

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
        // validating / in_progress / cancelling — keep polling.
        if (batch.status !== row.status) {
          db()
            .prepare("UPDATE consolidator_runs SET status = ? WHERE id = ?")
            .run(batch.status, row.id);
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

  const provider = llm();
  if (!hasBatch(provider)) {
    out.failed_tasks.push(`${batchId}: provider ${provider.name} has no batch results path`);
    return out;
  }

  const iter = await provider.batchResults(batchId);
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

  // Chat Completions (OpenAI-shaped): body.choices[0].message.content
  const choices = body["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const msg = (first as Record<string, unknown>)["message"] as
        | Record<string, unknown>
        | undefined;
      const content = msg?.["content"];
      if (typeof content === "string" && content.length > 0) return content;
    }
  }
  return null;
}
