import { GROK_READ_TOOLS } from "@/clients/brain";
import { llm } from "@/clients/llm";
import type { LlmCall, LlmResult, LlmTool } from "@/clients/llm";
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

  const baseCall: LlmCall = {
    model: env.LLM_MODEL_REASONER,
    messages: [
      ...systemPrompts.map((content) => ({ role: "system" as const, content })),
      { role: "user" as const, content: userInput },
    ],
    tools,
    parallelToolCalls: true,
    maxTurns: MAX_TURNS,
    include: ["mcp_call_output", "reasoning.encrypted_content", "x_search_call.action.sources"],
    promptCacheKey: PROMPT_CACHE_KEY,
    structuredOutput: {
      name: "CandidateBatch",
      schema: CANDIDATE_BATCH_SCHEMA as unknown as Record<string, unknown>,
      strict: true,
    },
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  let result: LlmResult<{ candidates: unknown[] }>;
  try {
    result = await provider.chat<{ candidates: unknown[] }>(baseCall);
  } catch (err) {
    log.error({ err, durationMs: Date.now() - t0 }, "reasoner.call_failed");
    return [];
  }

  let parsedCandidates = (result.parsed?.candidates ?? []) as unknown[];
  let toolCallCount = result.toolCalls.length;
  let responseId = result.responseId;
  let previousResponseId: string | null = null;
  let usage = result.usage;
  let stuck = false;

  // Stuck mid-thought: provider used tools but produced no candidates. Chain
  // once via previous_response_id to let it finish. Only if the provider
  // supports stored conversations (xAI, OpenAI Responses). Others skip.
  if (
    parsedCandidates.length === 0 &&
    toolCallCount > 0 &&
    provider.capabilities.previousResponseId
  ) {
    stuck = true;
    log.info(
      { response_id: responseId, tool_calls: toolCallCount },
      "reasoner.stuck_mid_thought.retry",
    );
    try {
      const retry = await provider.chat<{ candidates: unknown[] }>({
        ...baseCall,
        messages: [
          ...systemPrompts.map((content) => ({ role: "system" as const, content })),
          { role: "user" as const, content: "Continue. Emit the final CandidateBatch JSON now." },
        ],
        previousResponseId: responseId,
      });
      parsedCandidates = (retry.parsed?.candidates ?? []) as unknown[];
      previousResponseId = responseId;
      responseId = retry.responseId;
      toolCallCount += retry.toolCalls.length;
      usage = {
        inputTokens: usage.inputTokens + retry.usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens + retry.usage.cachedInputTokens,
        outputTokens: usage.outputTokens + retry.usage.outputTokens,
        reasoningTokens: usage.reasoningTokens + retry.usage.reasoningTokens,
        costInUsdTicks: usage.costInUsdTicks + retry.usage.costInUsdTicks,
      };
    } catch (err) {
      log.error({ err, response_id: responseId }, "reasoner.retry_failed");
    }
  }

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
        previousResponseId,
        candidates.length,
        toolCallCount,
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
      tool_calls: toolCallCount,
      stuck_mid_thought: stuck,
      durationMs: Date.now() - t0,
      response_id: responseId,
      previous_response_id: previousResponseId,
      usage,
    },
    "reasoner.tick",
  );

  return candidates;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
