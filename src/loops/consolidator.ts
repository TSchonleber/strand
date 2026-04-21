import { GROK_CONSOLIDATOR_TOOLS } from "@/clients/brain";
import { type GrokTool, brainctlMcpTool, grokCall } from "@/clients/grok";
import { env } from "@/config";
import { loadPrompt } from "@/prompts";
import { loopLog } from "@/util/log";

const log = loopLog("consolidator");

/**
 * Nightly consolidation job. When ready, switch to Batch API for 50%
 * off — see grokDeferredCreate / batch endpoints in src/clients/grok.ts.
 */
export async function consolidatorRun(): Promise<void> {
  const t0 = Date.now();

  const prompt = loadPrompt("consolidator.system");

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

  const result = await grokCall({
    model: env.GROK_MODEL_REASONER,
    systemPrompts: [
      `# consolidator\n${prompt.content}`,
      `# prompt_versions: consolidator=${prompt.hash}`,
    ],
    userInput:
      "Run nightly consolidation. Use dream_cycle, consolidation_run, reflexion_write, gaps_scan, retirement_analysis. Report what you changed in a compact JSON summary.",
    tools,
    maxOutputTokens: 8000,
  });

  log.info(
    {
      durationMs: Date.now() - t0,
      response_id: result.responseId,
      usage: result.usage,
      tool_calls: result.toolCalls.length,
    },
    "consolidator.done",
  );
}
