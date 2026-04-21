import { persona } from "@/config";

/**
 * Cheap local pre-filter to avoid paying xAI's $0.05 usage-guideline
 * violation fee on predictably-bad prompts. This is not a safety layer —
 * it's a cost guard. Grok's own filters still apply on top.
 */

const PROFANITY_PATTERNS: RegExp[] = [
  // Extend as needed. Keep conservative; false positives waste candidate slots.
  /\b(kill yourself|kys)\b/i,
];

export interface PrefilterResult {
  ok: boolean;
  reasons: string[];
}

export function prefilterText(text: string): PrefilterResult {
  const reasons: string[] = [];

  for (const p of PROFANITY_PATTERNS) {
    if (p.test(text)) reasons.push(`matches_pattern:${p.source}`);
  }

  for (const topic of persona.banned_topics) {
    if (text.toLowerCase().includes(topic.toLowerCase())) {
      reasons.push(`banned_topic:${topic}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
