import { GROK_READ_TOOLS } from "@/clients/brain";
import { type GrokTool, brainctlMcpTool, grokCall } from "@/clients/grok";
import { env, persona } from "@/config";
import { db } from "@/db";
import { loadPrompt } from "@/prompts";
import { type CandidateEnvelope, CandidateEnvelopeSchema, proposed } from "@/types/actions";
import { loopLog } from "@/util/log";

const log = loopLog("reasoner");

const CANDIDATE_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 10,
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
          action: { type: "object" }, // validated with Zod post-hoc
          rationale: { type: "string", maxLength: 2000 },
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

export async function reasonerTick(): Promise<CandidateEnvelope[]> {
  const t0 = Date.now();

  const recentEvents = db()
    .prepare(
      "SELECT id, kind, payload_json, created_at FROM perceived_events ORDER BY created_at DESC LIMIT 50",
    )
    .all() as Array<{ id: string; kind: string; payload_json: string; created_at: string }>;

  const personaPrompt = loadPrompt("persona");
  const reasonerPrompt = loadPrompt("reasoner.system");

  const tools: GrokTool[] = [{ type: "x_search" }, { type: "web_search" }];

  if (env.BRAINCTL_REMOTE_MCP_URL) {
    tools.push(
      brainctlMcpTool({
        url: env.BRAINCTL_REMOTE_MCP_URL,
        ...(env.BRAINCTL_REMOTE_MCP_TOKEN ? { token: env.BRAINCTL_REMOTE_MCP_TOKEN } : {}),
        allowedTools: GROK_READ_TOOLS,
      }),
    );
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
      "Propose up to 10 candidate actions. Use brainctl (memory_search, entity_get, tom_perspective_get, policy_match) before proposing any reply/DM. Use x_search to scout beyond the recent events if it will improve a decision. Output strictly matches the JSON schema.",
  });

  const result = await grokCall<{ candidates: unknown[] }>({
    model: env.GROK_MODEL_REASONER,
    systemPrompts: [
      `# persona\n${personaPrompt.content}`,
      `# reasoner\n${reasonerPrompt.content}`,
      `# prompt_versions: persona=${personaPrompt.hash} reasoner=${reasonerPrompt.hash}`,
    ],
    userInput,
    tools,
    responseSchema: {
      name: "CandidateBatch",
      schema: CANDIDATE_BATCH_SCHEMA as unknown as Record<string, unknown>,
      strict: true,
    },
    maxOutputTokens: 6000,
  });

  const parsedCandidates = (result.parsed?.candidates ?? []) as unknown[];
  const candidates: CandidateEnvelope[] = [];
  for (const raw of parsedCandidates) {
    const check = CandidateEnvelopeSchema.safeParse(raw);
    if (!check.success) {
      log.warn({ err: check.error.flatten() }, "reasoner.candidate_invalid");
      continue;
    }
    const env_: CandidateEnvelope = { ...check.data, modelResponseId: result.responseId };
    candidates.push(env_);
    // Use `proposed` to smoke-test typestate wrapping without actually using it downstream
    void proposed(env_);
  }

  log.info(
    {
      count: candidates.length,
      durationMs: Date.now() - t0,
      response_id: result.responseId,
      usage: result.usage,
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
