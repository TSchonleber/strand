import { runAgenticLoop } from "@/agent/loop";
import { GROK_READ_TOOLS } from "@/clients/brain";
import { llm } from "@/clients/llm";
import type { LlmTool } from "@/clients/llm";
import { env, persona } from "@/config";
import { db } from "@/db";
import { loadPrompt } from "@/prompts";
import { type CandidateEnvelope, CandidateEnvelopeSchema, proposed } from "@/types/actions";
import { loopLog } from "@/util/log";

const log = loopLog("reasoner");

// ─── JSON schema for xAI structured output ───────────────────
//
// xAI rejects: allOf, min/maxLength, min/maxItems. Every length/count
// constraint is enforced in Zod post-parse via CandidateEnvelopeSchema.
// Discriminated unions are expressed via anyOf + a literal `kind`.

const textProp = { type: "string" } as const;
const idProp = { type: "string" } as const;

const ACTION_ANYOF = [
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "tweetId"],
    properties: {
      kind: { type: "string", const: "like" },
      tweetId: idProp,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "tweetId"],
    properties: {
      kind: { type: "string", const: "bookmark" },
      tweetId: idProp,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "tweetId", "text"],
    properties: {
      kind: { type: "string", const: "reply" },
      tweetId: idProp,
      text: textProp,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "tweetId", "text"],
    properties: {
      kind: { type: "string", const: "quote" },
      tweetId: idProp,
      text: textProp,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "text"],
    properties: {
      kind: { type: "string", const: "post" },
      text: textProp,
      mediaIds: { type: "array", items: { type: "string" } },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "userId"],
    properties: {
      kind: { type: "string", const: "follow" },
      userId: idProp,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "userId"],
    properties: {
      kind: { type: "string", const: "unfollow" },
      userId: idProp,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["kind", "userId", "text"],
    properties: {
      kind: { type: "string", const: "dm" },
      userId: idProp,
      text: textProp,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: [
      "kind",
      "sourceTweetId",
      "sourceUserId",
      "ideaSummary",
      "problemStatement",
      "proposedApproach",
      "estimatedEffortHours",
      "requiredCapabilities",
      "feasibilityScore",
    ],
    properties: {
      kind: { type: "string", const: "project_proposal" },
      sourceTweetId: idProp,
      sourceUserId: idProp,
      ideaSummary: { type: "string" },
      problemStatement: { type: "string" },
      proposedApproach: { type: "string" },
      estimatedEffortHours: { type: "integer" },
      requiredCapabilities: { type: "array", items: { type: "string" } },
      feasibilityScore: { type: "number", minimum: 0, maximum: 1 },
      legalRiskFlags: { type: "array", items: { type: "string" } },
      competitiveLandscape: { type: "string" },
    },
  },
] as const;

const CANDIDATE_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "action",
          "rationale",
          "confidence",
          "relevanceScore",
          "sourceEventIds",
          "requiresHumanReview",
        ],
        properties: {
          action: { anyOf: ACTION_ANYOF },
          rationale: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          targetEntityId: { type: "string" },
          relevanceScore: { type: "number", minimum: 0, maximum: 1 },
          sourceEventIds: { type: "array", items: { type: "string" } },
          requiresHumanReview: { type: "boolean" },
        },
      },
    },
  },
} as const;

const PROMPT_CACHE_KEY = "strand:reasoner:v1";
const MAX_TURNS = 5;
const MAX_OUTPUT_TOKENS = 6000;
/** Cap on agentic-loop iterations. Replaces the old single stuck-mid-thought retry. */
const MAX_LOOP_ITERATIONS = 3;

/**
 * A single Reasoner tick. Calls Grok with tools (x_search, web_search,
 * brainctl MCP read allowlist) and returns zero or more CandidateEnvelopes.
 *
 * Behavior on "stuck mid-thought" (no candidates but tool calls happened):
 * re-invoke once with previous_response_id to let Grok finish the chain.
 * Bounded to one chain per tick to cap cost.
 *
 * Every tick writes a row to `reasoner_runs`. On a 500 / client error we
 * log the error and return []; no DB insert happens in that case so the
 * run counter stays honest.
 */
export async function reasonerTick(): Promise<CandidateEnvelope[]> {
  const t0 = Date.now();

  const recentEvents = db()
    .prepare(
      "SELECT id, kind, payload_json, created_at FROM perceived_events ORDER BY created_at DESC LIMIT 50",
    )
    .all() as Array<{ id: string; kind: string; payload_json: string; created_at: string }>;

  const personaPrompt = loadPrompt("persona");
  const reasonerPrompt = loadPrompt("reasoner.system");

  const provider = llm();

  // Tools: provider-native server-side tools + MCP. Adapters drop what they
  // don't support (e.g., OpenAI Chat Completions drops x_search; Gemini drops mcp).
  const tools: LlmTool[] = [];
  for (const serverTool of provider.capabilities.serverSideTools) {
    if (serverTool === "x_search" || serverTool === "web_search") {
      tools.push({ type: serverTool });
    }
  }

  if (provider.capabilities.mcp && env.BRAINCTL_REMOTE_MCP_URL) {
    tools.push({
      type: "mcp",
      server_label: "brainctl",
      server_description: "Strand long-term memory",
      server_url: env.BRAINCTL_REMOTE_MCP_URL,
      ...(env.BRAINCTL_REMOTE_MCP_TOKEN
        ? { authorization: `Bearer ${env.BRAINCTL_REMOTE_MCP_TOKEN}` }
        : {}),
      allowed_tools: [...GROK_READ_TOOLS],
    });
  }

  const userInput = JSON.stringify({
    mode: env.STRAND_MODE,
    persona_handle: persona.handle,
    topics: persona.topics,
    banned_topics: persona.banned_topics,
    recent_events: recentEvents.map((e) => ({
      id: e.id,
      kind: e.kind,
      at: e.created_at,
      event: safeParse(e.payload_json),
    })),
    instruction:
      "Propose up to 10 candidate actions. Use brainctl (memory_search, entity_get, tom_perspective_get, policy_match) before proposing any reply/DM/quote/project_proposal. Use x_search to scout beyond recent events only if it materially improves a decision. Output strictly matches the JSON schema.",
  });

  const systemPrompts = [
    `# persona\n${personaPrompt.content}`,
    `# reasoner\n${reasonerPrompt.content}`,
    `# prompt_versions: persona=${personaPrompt.hash} reasoner=${reasonerPrompt.hash}`,
  ];

  // Drive through the provider-agnostic agentic loop runner.
  // The loop owns chat→tool→chat iteration; server-side tools (x_search,
  // web_search) + MCP are handled inside the provider per-call. Local
  // function tools (none today) would plug in via `localTools`.
  let loop: Awaited<ReturnType<typeof runAgenticLoop>>;
  try {
    loop = await runAgenticLoop({
      provider,
      model: env.LLM_MODEL_REASONER,
      messages: [
        ...systemPrompts.map((content) => ({ role: "system" as const, content })),
        { role: "user" as const, content: userInput },
      ],
      tools,
      parallelToolCalls: true,
      maxTurns: MAX_TURNS,
      maxIterations: MAX_LOOP_ITERATIONS,
      include: ["mcp_call_output", "reasoning.encrypted_content", "x_search_call.action.sources"],
      promptCacheKey: PROMPT_CACHE_KEY,
      structuredOutput: {
        name: "CandidateBatch",
        schema: CANDIDATE_BATCH_SCHEMA as unknown as Record<string, unknown>,
        strict: true,
      },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    log.error({ err, durationMs: Date.now() - t0 }, "reasoner.call_failed");
    return [];
  }

  // Loop surfaces provider errors via stopReason rather than throwing. Treat
  // that as a hard failure: no row insert, empty return — matches the old
  // "throw on call" behavior so the run counter stays honest.
  if (loop.stopReason === "error") {
    log.error({ iterations: loop.iterations, durationMs: Date.now() - t0 }, "reasoner.loop_error");
    return [];
  }

  const parsed = safeJsonCandidates(loop.finalText);
  const parsedCandidates = parsed?.candidates ?? [];
  const responseId = loop.finalResponseId;
  const usage = loop.usage;
  // `stuck_mid_thought` now means the loop took >1 iteration to finish
  // (model used tools, then had to be nudged back to emit the final JSON).
  const stuck = loop.iterations > 1;

  const candidates: CandidateEnvelope[] = [];
  for (const raw of parsedCandidates) {
    const check = CandidateEnvelopeSchema.safeParse(raw);
    if (!check.success) {
      log.warn({ err: check.error.flatten() }, "reasoner.candidate_invalid");
      continue;
    }
    const envelope: CandidateEnvelope = { ...check.data, modelResponseId: responseId };
    candidates.push(envelope);
    void proposed(envelope);
  }

  try {
    db()
      .prepare(
        `INSERT INTO reasoner_runs (
          response_id, previous_response_id, candidate_count, tool_call_count,
          usage_json, cost_in_usd_ticks, stuck_mid_thought
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        responseId || null,
        null, // previous_response_id no longer meaningful — loop owns history locally
        candidates.length,
        loop.toolCallsTotal,
        JSON.stringify(usage),
        usage.costInUsdTicks,
        stuck ? 1 : 0,
      );
  } catch (err) {
    log.warn({ err }, "reasoner.runs_insert_failed");
  }

  log.info(
    {
      count: candidates.length,
      tool_calls: loop.toolCallsTotal,
      iterations: loop.iterations,
      stop_reason: loop.stopReason,
      stuck_mid_thought: stuck,
      durationMs: Date.now() - t0,
      response_id: responseId,
      usage,
    },
    "reasoner.tick",
  );

  return candidates;
}

function safeJsonCandidates(s: string): { candidates: unknown[] } | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(s) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      Array.isArray((obj as { candidates?: unknown[] }).candidates)
    ) {
      return obj as { candidates: unknown[] };
    }
    return null;
  } catch {
    return null;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
