import { env } from "@/config";
import { log } from "@/util/log";
import OpenAI, { toFile } from "openai";
import { z } from "zod";

/**
 * Grok client. OpenAI SDK pointed at xAI's Responses API.
 *
 * Rules enforced here (ground-truthed against docs.x.ai, 2026-04-20):
 *  - reasoning models reject presence_penalty / frequency_penalty / stop / reasoning_effort
 *  - logprobs silently ignored on grok-4.20 / grok-4-1-fast — we drop it
 *  - prompt_cache_key pinned per loop+tenant (critical for cache hit rate)
 *  - max_turns caps agentic server-side tool chains (Reasoner default 5)
 *  - include surfaces mcp_call_output + reasoning.encrypted_content for replay
 *  - every call logs response.id + system_fingerprint + usage + cost_in_usd_ticks
 *  - Deferred Completions is Chat-Completions-only; Batch API handles async Responses
 */

const REASONING_MODEL_SUBSTRINGS = [
  "grok-4.20-reasoning",
  "grok-4.20-0309-reasoning",
  "grok-4-reasoning",
  "grok-4-1-fast-reasoning",
  "grok-4.20-multi-agent",
];

function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_SUBSTRINGS.some((s) => model.includes(s));
}

const client = new OpenAI({
  apiKey: env.XAI_API_KEY,
  baseURL: env.XAI_BASE_URL,
});

export type GrokTool =
  | {
      type: "x_search";
      allowed_x_handles?: string[];
      excluded_x_handles?: string[];
      from_date?: string;
      to_date?: string;
      enable_image_understanding?: boolean;
      enable_video_understanding?: boolean;
    }
  | {
      type: "web_search";
      allowed_domains?: string[];
      excluded_domains?: string[];
      enable_image_understanding?: boolean;
    }
  | { type: "code_interpreter" }
  | {
      type: "mcp";
      server_label: string;
      server_url: string;
      server_description?: string;
      authorization?: string;
      headers?: Record<string, string>;
      allowed_tools?: string[];
    }
  | {
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
      };
    };

export type GrokInclude =
  | "mcp_call_output"
  | "reasoning.encrypted_content"
  | "web_search_call.action.sources"
  | "x_search_call.action.sources"
  | "inline_citations";

export interface GrokCallInput {
  model: string;
  systemPrompts: string[]; // concatenated as static prefix for caching
  userInput: string;
  tools?: GrokTool[];
  toolChoice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  parallelToolCalls?: boolean;
  maxTurns?: number;
  temperature?: number;
  maxOutputTokens?: number;
  responseSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
  /**
   * Pin server-side routing for prompt cache hits. Use a stable string per
   * loop+tenant, e.g. "strand:reasoner:v3". Without this, cache hit rate
   * collapses on multi-instance routing. Non-optional in practice.
   */
  promptCacheKey?: string;
  /** Surface MCP outputs / encrypted reasoning / citations in response for replay. */
  include?: GrokInclude[];
  /** Continue a stored conversation (server-side history retained 30d). */
  previousResponseId?: string;
  /** Opt out of server-side storage (also disables encrypted-reasoning passthrough). */
  store?: boolean;
}

export interface GrokCallOutput<T = unknown> {
  outputText: string;
  parsed: T | null;
  responseId: string;
  systemFingerprint: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    /** xAI cost meter: integer, units of 1e-10 USD. Divide by 1e10 for dollars. */
    costInUsdTicks: number;
  };
  toolCalls: Array<{ name: string; args: unknown }>;
  rawResponse: unknown;
}

/**
 * Strip fields that reasoning models reject. Rather than filtering per-model
 * at the call site, we centralize it here so adding a new reasoning model =
 * updating REASONING_MODEL_PREFIXES only.
 */
function buildRequest(input: GrokCallInput): Record<string, unknown> {
  const req: Record<string, unknown> = {
    model: input.model,
    input: [
      ...input.systemPrompts.map((content) => ({ role: "system", content })),
      { role: "user", content: input.userInput },
    ],
  };

  if (input.tools && input.tools.length > 0) req["tools"] = input.tools;
  if (input.toolChoice !== undefined) req["tool_choice"] = input.toolChoice;
  if (input.parallelToolCalls !== undefined) req["parallel_tool_calls"] = input.parallelToolCalls;
  if (input.maxTurns !== undefined) req["max_turns"] = input.maxTurns;
  if (input.maxOutputTokens) req["max_output_tokens"] = input.maxOutputTokens;
  if (input.promptCacheKey) req["prompt_cache_key"] = input.promptCacheKey;
  if (input.include && input.include.length > 0) req["include"] = input.include;
  if (input.previousResponseId) req["previous_response_id"] = input.previousResponseId;
  if (input.store !== undefined) req["store"] = input.store;

  if (input.responseSchema) {
    req["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: input.responseSchema.name,
        schema: input.responseSchema.schema,
        strict: input.responseSchema.strict ?? true,
      },
    };
  }

  if (!isReasoningModel(input.model)) {
    if (input.temperature !== undefined) req["temperature"] = input.temperature;
  }
  // Do NOT send presence_penalty / frequency_penalty / stop / reasoning_effort / logprobs.
  // Reasoning models reject them; non-reasoning models get defaults that work fine.

  return req;
}

export async function grokCall<T = unknown>(input: GrokCallInput): Promise<GrokCallOutput<T>> {
  const req = buildRequest(input);
  const t0 = Date.now();

  // Cast to `any` at the SDK boundary — the OpenAI SDK Responses API types
  // lag behind xAI's additions (x_search, mcp). Types are still enforced at
  // our call-site via GrokCallInput above.
  // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
  const resp = (await (client as any).responses.create(req)) as Record<string, unknown>;

  const responseId = String(resp["id"] ?? "");
  const systemFingerprint = (resp["system_fingerprint"] as string | undefined) ?? null;
  const outputText = String((resp as { output_text?: string }).output_text ?? "");
  const usageRaw = (resp["usage"] as Record<string, number>) ?? {};

  const inputDetails =
    (usageRaw["input_tokens_details"] as Record<string, number> | undefined) ?? {};
  const outputDetails =
    (usageRaw["output_tokens_details"] as Record<string, number> | undefined) ?? {};
  const usage = {
    inputTokens: usageRaw["input_tokens"] ?? usageRaw["prompt_tokens"] ?? 0,
    cachedInputTokens:
      inputDetails["cached_tokens"] ??
      usageRaw["cached_input_tokens"] ??
      usageRaw["prompt_tokens_cached"] ??
      0,
    outputTokens: usageRaw["output_tokens"] ?? usageRaw["completion_tokens"] ?? 0,
    reasoningTokens: outputDetails["reasoning_tokens"] ?? usageRaw["reasoning_tokens"] ?? 0,
    costInUsdTicks: (usageRaw["cost_in_usd_ticks"] as number | undefined) ?? 0,
  };

  const toolCalls = extractToolCalls(resp);

  log.info(
    {
      svc: "grok",
      model: input.model,
      response_id: responseId,
      system_fingerprint: systemFingerprint,
      durationMs: Date.now() - t0,
      usage,
      tool_calls: toolCalls.length,
    },
    "grok.call",
  );

  let parsed: T | null = null;
  if (input.responseSchema && outputText) {
    try {
      parsed = JSON.parse(outputText) as T;
    } catch (e) {
      log.warn({ err: e }, "grok.parse_failed");
    }
  }

  return { outputText, parsed, responseId, systemFingerprint, usage, toolCalls, rawResponse: resp };
}

function extractToolCalls(resp: Record<string, unknown>): Array<{ name: string; args: unknown }> {
  const out: Array<{ name: string; args: unknown }> = [];
  const output = (resp["output"] as unknown[] | undefined) ?? [];
  for (const item of output) {
    const i = item as Record<string, unknown>;
    if (i["type"] === "tool_use" || i["type"] === "function_call") {
      out.push({
        name: String(i["name"] ?? "unknown"),
        args: i["arguments"] ?? i["input"] ?? null,
      });
    }
  }
  return out;
}

/**
 * Helper to build a brainctl remote-MCP tool config.
 * brainctl MUST expose Streaming HTTP or SSE — xAI rejects stdio MCP.
 * `authorization` passes as the HTTP Authorization header to brainctl.
 * `allowed_tools` is the only gate — xAI doesn't support `require_approval`.
 */
export function brainctlMcpTool(args: {
  url: string;
  token?: string;
  allowedTools: string[];
  headers?: Record<string, string>;
}): GrokTool {
  return {
    type: "mcp",
    server_label: "brainctl",
    server_description: "Strand long-term memory",
    server_url: args.url,
    ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
    ...(args.headers ? { headers: args.headers } : {}),
    allowed_tools: args.allowedTools,
  };
}

/** Allowlist for the Reasoner — read-only brainctl surface. */
export const REASONER_MCP_ALLOWLIST = [
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
  "temporal_auto_detect",
  "temporal_chain",
  "temporal_context",
  "temporal_causes",
  "temporal_effects",
  "temporal_map",
];

/** Allowlist for the Consolidator — read-only + consolidation-write surface. */
export const CONSOLIDATOR_MCP_ALLOWLIST = [
  ...REASONER_MCP_ALLOWLIST,
  "reflexion_write",
  "dream_cycle",
  "consolidation_run",
  "gaps_scan",
  "retirement_analysis",
];

// ─── Batch API ───────────────────────────────────────────────
// Consolidator async path. Deferred Completions is Chat-Completions-only —
// not usable for Responses API, so we don't implement it.
//
// Flow: upload JSONL to /v1/files → POST /v1/batches with input_file_id →
// poll GET /v1/batches/:id → fetch results (either via output_file_id +
// files.content, or a direct result_url the server hands back). 50% off all
// token classes. Up to 50k requests/file, 200MB/file, ~24h SLA.

export interface GrokBatch {
  id: string;
  status:
    | "validating"
    | "in_progress"
    | "completed"
    | "failed"
    | "expired"
    | "cancelling"
    | "cancelled"
    | "finalizing";
  input_file_id: string;
  output_file_id?: string;
  error_file_id?: string;
  created_at: number;
  completed_at?: number;
  request_counts?: { total: number; completed: number; failed: number };
  endpoint?: string;
  completion_window?: string;
  /** Some providers (xAI seen in the wild) return a direct URL for results. */
  output_file_url?: string;
  result_url?: string;
  results_url?: string;
}

export interface GrokBatchLine {
  id: string;
  custom_id: string;
  response?: { status_code: number; body: Record<string, unknown> };
  error?: { code: string; message: string };
}

/**
 * Build a single JSONL line for the Batch API. The `body` must already be a
 * snake_case, model-class-clean /v1/responses request (see buildResponsesBody).
 */
export function buildBatchRequestLine(args: {
  customId: string;
  url: "/v1/responses" | "/v1/chat/completions";
  body: Record<string, unknown>;
}): string {
  return JSON.stringify({
    custom_id: args.customId,
    method: "POST",
    url: args.url,
    body: args.body,
  });
}

/**
 * Build a /v1/responses request body suitable for batching. Mirrors the
 * reasoning-model param hygiene enforced by buildRequest() above — kept as a
 * sibling helper so the sync path (grokCall) stays untouched this pass.
 *
 * If the two drift, reconcile by having buildRequest() delegate to this.
 */
export function buildResponsesBody(input: GrokCallInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    input: [
      ...input.systemPrompts.map((content) => ({ role: "system", content })),
      { role: "user", content: input.userInput },
    ],
  };

  if (input.tools && input.tools.length > 0) body["tools"] = input.tools;
  if (input.toolChoice !== undefined) body["tool_choice"] = input.toolChoice;
  if (input.parallelToolCalls !== undefined) body["parallel_tool_calls"] = input.parallelToolCalls;
  if (input.maxTurns !== undefined) body["max_turns"] = input.maxTurns;
  if (input.maxOutputTokens) body["max_output_tokens"] = input.maxOutputTokens;
  if (input.promptCacheKey) body["prompt_cache_key"] = input.promptCacheKey;
  if (input.include && input.include.length > 0) body["include"] = input.include;
  if (input.previousResponseId) body["previous_response_id"] = input.previousResponseId;
  if (input.store !== undefined) body["store"] = input.store;

  if (input.responseSchema) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: {
        name: input.responseSchema.name,
        schema: input.responseSchema.schema,
        strict: input.responseSchema.strict ?? true,
      },
    };
  }

  if (!isReasoningModel(input.model) && input.temperature !== undefined) {
    body["temperature"] = input.temperature;
  }
  // Reasoning models reject presence_penalty / frequency_penalty / stop /
  // reasoning_effort; logprobs is silently ignored. We never send them.

  return body;
}

/**
 * Upload a JSONL blob to xAI's /v1/files as a batch input. Returns { id }.
 * The SDK routes to `baseURL`, so this hits api.x.ai/v1/files.
 */
export async function grokFilesUpload(
  jsonl: string,
  purpose: "batch" = "batch",
): Promise<{ id: string }> {
  const file = await toFile(Buffer.from(jsonl, "utf8"), "batch.jsonl", {
    type: "application/jsonl",
  });
  // biome-ignore lint/suspicious/noExplicitAny: SDK boundary — xAI accepts "batch" purpose
  const resp = await (client.files as any).create({ file, purpose });
  const id = String((resp as { id?: string }).id ?? "");
  log.info({ svc: "grok", file_id: id, purpose }, "grok.files.upload");
  return { id };
}

/** Create a batch over an uploaded JSONL input file. */
export async function grokBatchCreate(args: {
  inputFileId: string;
  endpoint?: "/v1/responses" | "/v1/chat/completions";
  completionWindow?: "24h";
  metadata?: Record<string, string>;
}): Promise<GrokBatch> {
  const body = {
    input_file_id: args.inputFileId,
    endpoint: args.endpoint ?? "/v1/responses",
    completion_window: args.completionWindow ?? "24h",
    ...(args.metadata ? { metadata: args.metadata } : {}),
  };
  // biome-ignore lint/suspicious/noExplicitAny: SDK boundary — xAI accepts /v1/responses endpoint
  const resp = (await (client.batches as any).create(body)) as GrokBatch;
  log.info(
    {
      svc: "grok",
      batch_id: resp.id,
      status: resp.status,
      endpoint: resp.endpoint,
      input_file_id: resp.input_file_id,
    },
    "grok.batch.create",
  );
  return resp;
}

/** Retrieve a batch by id. */
export async function grokBatchGet(id: string): Promise<GrokBatch> {
  // biome-ignore lint/suspicious/noExplicitAny: SDK boundary — typings lag xAI fields
  const resp = (await (client.batches as any).retrieve(id)) as GrokBatch;
  log.debug(
    {
      svc: "grok",
      batch_id: resp.id,
      status: resp.status,
      request_counts: resp.request_counts,
    },
    "grok.batch.get",
  );
  return resp;
}

/**
 * Fetch and parse batch results as an async iterable of JSONL lines.
 *
 * Two retrieval shapes, per xAI observed behavior:
 *   - `output_file_id`: use SDK files.content() to download.
 *   - `output_file_url` / `result_url` / `results_url`: GET the direct URL.
 *
 * Emits a warning if request_counts.failed > 0 (partial-completion case).
 */
export async function grokBatchResults(id: string): Promise<AsyncIterable<GrokBatchLine>> {
  const batch = await grokBatchGet(id);

  const failed = batch.request_counts?.failed ?? 0;
  if (failed > 0) {
    log.warn(
      {
        svc: "grok",
        batch_id: id,
        request_counts: batch.request_counts,
      },
      "grok.batch.partial_failures",
    );
  }

  const directUrl = batch.output_file_url ?? batch.result_url ?? batch.results_url;
  let text: string;
  if (directUrl) {
    const resp = await fetch(directUrl);
    if (!resp.ok) {
      throw new Error(`grokBatchResults: fetch ${directUrl} → ${resp.status}`);
    }
    text = await resp.text();
  } else if (batch.output_file_id) {
    // biome-ignore lint/suspicious/noExplicitAny: SDK boundary
    const fileResp = await (client.files as any).content(batch.output_file_id);
    // Node fetch Response, Web Response, or SDK-wrapped string — all expose text().
    if (typeof fileResp === "string") {
      text = fileResp;
    } else if (
      fileResp &&
      typeof (fileResp as { text?: () => Promise<string> }).text === "function"
    ) {
      text = await (fileResp as { text: () => Promise<string> }).text();
    } else {
      text = String(fileResp);
    }
  } else {
    throw new Error(
      `grokBatchResults: batch ${id} has no output_file_id or result url (status=${batch.status})`,
    );
  }

  return toAsyncIterable(parseJsonlLines(text));
}

function toAsyncIterable<T>(src: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const v of src) yield v;
    },
  };
}

function* parseJsonlLines(text: string): Iterable<GrokBatchLine> {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line) as GrokBatchLine;
    } catch (err) {
      log.warn({ svc: "grok", err, line: line.slice(0, 200) }, "grok.batch.parse_line_failed");
    }
  }
}

// ─── Response schema for CandidateEnvelope[] ─────────────────

export const CandidateBatchSchema = z.object({
  candidates: z.array(z.record(z.string(), z.unknown())).default([]),
});
