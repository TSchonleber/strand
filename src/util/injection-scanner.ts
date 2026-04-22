/**
 * Prompt-injection scanner for untrusted text.
 *
 * Any text that flows into the LLM's message stream from outside the
 * harness — tool results, fetched HTTP bodies, files read by the agent,
 * repository context files — must pass through this scanner first.
 *
 * What it catches:
 *   1. Instruction-override phrases ("ignore previous instructions", etc.)
 *   2. Role-injection markers for common chat formats (ChatML, Llama,
 *      Anthropic `<system>` tags, OpenAI end-of-text sentinel).
 *   3. Invisible / bidi-override unicode that can hide instructions in
 *      plain-looking text. Counted per class AND stripped from `sanitized`.
 *   4. Soft-signal data-exfil patterns ("curl ... | bash",
 *      "send this prompt to ...").
 *
 * Design:
 *   - Pure, deterministic, no I/O, no deps.
 *   - Results are advisory: the caller decides whether to block, warn, or
 *     pass the sanitized text through with a model-visible prefix.
 *   - `safe` is strict: any `high`-severity finding flips it to false.
 *   - Invisibles are ALWAYS stripped into `sanitized`, regardless of whether
 *     the finding was warn/high. Caller picks which version to use.
 *   - Inputs above `maxSize` (1 MB default) are scanned head + tail only
 *     (256 KB each) — injections typically live at the edges of a dump.
 */

export type Severity = "info" | "warn" | "high";

export interface Rule {
  /** Stable id for the rule (used in Finding.rule). */
  id: string;
  /** Pattern to test. Scanner records the first match. */
  pattern: RegExp;
  /** Severity of a hit. */
  severity: Severity;
}

export interface Finding {
  rule: string;
  severity: Severity;
  /** First 120 chars of the matched substring (regex matches only). */
  match?: string;
  /** Count of occurrences — populated for invisible-unicode rules. */
  count?: number;
}

export interface ScanResult {
  /** True iff no `high`-severity finding was recorded. */
  safe: boolean;
  findings: Finding[];
  /**
   * The input with invisible + bidi-override characters stripped.
   * Caller may still choose to block, but this is what should be
   * forwarded to the model when passing the text through.
   */
  sanitized: string;
}

// ─── Default rules ──────────────────────────────────────────────────────────
//
// Severity rationale:
//   high  — the text is actively trying to override or jailbreak. Block
//           unless caller explicitly opts in.
//   warn  — suspicious signal but not conclusive. Log + include anyway.
//   info  — informational / soft signal.

export const DEFAULT_RULES: readonly Rule[] = Object.freeze([
  // Instruction-override phrases — these are the canonical prompt-injection
  // payloads. `high` severity: any hit blocks by default.
  {
    id: "instruction_override_ignore",
    pattern: /ignore (all )?(previous|prior|above) (instructions?|prompts?|context)/i,
    severity: "high",
  },
  {
    id: "instruction_override_disregard",
    pattern:
      /(disregard|forget|override) (all )?(previous|prior|above|your) (instructions?|rules?|prompts?|system prompt)/i,
    severity: "high",
  },
  {
    id: "instruction_override_new_directive",
    pattern: /new (instructions?|system prompt|directive)/i,
    severity: "high",
  },
  {
    id: "instruction_override_pretend",
    pattern: /pretend (that )?you are /i,
    severity: "high",
  },
  {
    id: "instruction_override_jailbreak",
    pattern: /(jailbreak|DAN mode|developer mode)/i,
    severity: "high",
  },
  // Soft signal — "you are now X" is a softer identity-swap attempt. Many
  // benign texts contain this phrase, so warn only.
  {
    id: "instruction_override_you_are_now",
    pattern: /you are (now|actually) /i,
    severity: "warn",
  },

  // Role-injection markers — stray chat-format control sequences in user
  // content are nearly always an attack. `high`.
  {
    id: "role_injection_chatml",
    pattern: /<\|im_(start|end)\|>/i,
    severity: "high",
  },
  {
    id: "role_injection_llama_inst",
    pattern: /\[INST\]|\[\/INST\]/,
    severity: "high",
  },
  {
    id: "role_injection_endoftext",
    pattern: /\|endoftext\|/,
    severity: "high",
  },
  {
    id: "role_injection_system_tag",
    pattern: /<\/system>|<system>|<user>|<assistant>/i,
    severity: "high",
  },

  // Data-exfil soft signals. Warn — these appear in legitimate docs.
  {
    id: "data_exfil_curl_pipe",
    pattern: /curl [^\n]+ \| (bash|sh)/i,
    severity: "warn",
  },
  {
    id: "data_exfil_wget_pipe",
    pattern: /wget [^\n]+ \| (bash|sh)/i,
    severity: "warn",
  },
  {
    id: "data_exfil_send_prompt",
    pattern: /send (this|above|the) (prompt|system) (to|via)/i,
    severity: "warn",
  },
]);

// ─── Invisible / bidi-override characters ──────────────────────────────────
//
// These aren't regex rules because we need a per-class count + a bulk strip
// at the end. Keep the two tables aligned — `INVISIBLE_CLASSES` drives both
// detection and sanitization.

interface InvisibleClass {
  id: string;
  chars: readonly string[];
  severity: Severity;
}

const INVISIBLE_CLASSES: readonly InvisibleClass[] = Object.freeze([
  {
    id: "invisible_zero_width",
    // U+200B zero-width space, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM,
    // U+2060 word joiner, U+180E Mongolian vowel separator.
    chars: ["\u200B", "\u200C", "\u200D", "\uFEFF", "\u2060", "\u180E"],
    severity: "warn",
  },
  {
    id: "invisible_bidi_override",
    // U+202A..U+202E (LRE RLE PDF LRO RLO), U+2066..U+2069 (LRI RLI FSI PDI).
    chars: [
      "\u202A",
      "\u202B",
      "\u202C",
      "\u202D",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ],
    severity: "warn",
  },
]);

/** Regex matching every invisible char from every class — used for strip. */
const INVISIBLE_STRIP_RE = (() => {
  const all = INVISIBLE_CLASSES.flatMap((c) => c.chars);
  // Escape each char in case any are regex-special (none currently are).
  const escaped = all.map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return new RegExp(`[${escaped.join("")}]`, "g");
})();

// ─── Size cap ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_SIZE = 1_000_000; // 1 MB
const EDGE_CHUNK = 256_000; // 256 KB

/**
 * Prepare the text to scan. Above `maxSize`, we keep just the first + last
 * EDGE_CHUNK bytes — injections tend to live at the edges of a large dump
 * (think: a long web page with a malicious footer, or a tool result with
 * a prompt-injection preamble).
 */
function prepareText(text: string, maxSize: number): string {
  if (text.length <= maxSize) return text;
  return `${text.slice(0, EDGE_CHUNK)}\n…\n${text.slice(text.length - EDGE_CHUNK)}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Custom rule set. Defaults to `DEFAULT_RULES`. */
  rules?: readonly Rule[];
  /** Max input size before head/tail truncation kicks in. Default 1 MB. */
  maxSize?: number;
}

export function scanForInjection(text: string, opts?: ScanOptions): ScanResult {
  const rules = opts?.rules ?? DEFAULT_RULES;
  const maxSize = opts?.maxSize ?? DEFAULT_MAX_SIZE;
  const scanned = prepareText(text, maxSize);
  const findings: Finding[] = [];

  // Regex rules.
  for (const rule of rules) {
    const m = rule.pattern.exec(scanned);
    if (m && m[0] !== undefined) {
      const f: Finding = {
        rule: rule.id,
        severity: rule.severity,
        match: m[0].slice(0, 120),
      };
      findings.push(f);
    }
  }

  // Invisible-character classes: count occurrences in the scanned slice.
  for (const cls of INVISIBLE_CLASSES) {
    let count = 0;
    for (const ch of cls.chars) {
      // String#split keyed on single char is faster than a regex here and
      // safe for the specific codepoints we're looking at.
      const parts = scanned.split(ch);
      if (parts.length > 1) count += parts.length - 1;
    }
    if (count > 0) {
      findings.push({
        rule: cls.id,
        severity: cls.severity,
        count,
      });
    }
  }

  // Sanitize: strip invisibles from the ORIGINAL text (not the truncated
  // scanned copy), so downstream code gets the full body minus the junk.
  const sanitized = text.replace(INVISIBLE_STRIP_RE, "");

  const safe = !findings.some((f) => f.severity === "high");
  return { safe, findings, sanitized };
}
