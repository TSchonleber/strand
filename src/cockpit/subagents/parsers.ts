/**
 * Stream parsers for cli-process subagent backends.
 *
 * Each parser transforms child process output (stdout/stderr lines) into
 * normalized CockpitEvents (`subagent.event` / `subagent.end`).
 */

import type { CockpitEvent } from "../core/events";

export interface ParsedChunk {
  events: CockpitEvent[];
}

export interface StreamParser {
  readonly name: string;
  /** Feed a single line of stdout. Returns zero or more CockpitEvents. */
  parseLine(subagentId: string, line: string): ParsedChunk;
  /** Called when the process exits. Returns final events if any. */
  finalize(subagentId: string, exitCode: number): ParsedChunk;
}

// ─── Raw-text fallback ──────────────────────────────────────────────────────

export class RawTextParser implements StreamParser {
  readonly name = "raw-text";

  parseLine(subagentId: string, line: string): ParsedChunk {
    return {
      events: [{ t: "subagent.event", subagentId, kind: "stdout", chunk: line }],
    };
  }

  finalize(subagentId: string, exitCode: number): ParsedChunk {
    return {
      events: [{ t: "subagent.end", subagentId, ok: exitCode === 0, exit: exitCode }],
    };
  }
}

// ─── Claude Code stream-json parser ─────────────────────────────────────────
//
// `claude -p --output-format stream-json` emits newline-delimited JSON.
// Each object has a `type` field. We map:
//   - type containing "content_block_delta" or text content -> subagent.event stdout
//   - type "system" or containing "api_retry"               -> subagent.event status
//   - type "result" (terminal)                              -> subagent.end
//   - everything else                                       -> subagent.event stdout
//
// The result event carries session_id, num_turns, total_cost_usd which we
// include as the subagent.end exit payload.

export class ClaudeCodeStreamParser implements StreamParser {
  readonly name = "claude-code-stream";

  parseLine(subagentId: string, line: string): ParsedChunk {
    const trimmed = line.trim();
    if (trimmed.length === 0) return { events: [] };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        events: [{ t: "subagent.event", subagentId, kind: "stdout", chunk: line }],
      };
    }

    const type = typeof parsed["type"] === "string" ? parsed["type"] : "";

    if (type === "result") {
      const ok = typeof parsed["is_error"] === "boolean" ? !parsed["is_error"] : true;
      return {
        events: [{ t: "subagent.end", subagentId, ok, exit: ok ? 0 : 1 }],
      };
    }

    if (type === "system" || type.includes("api_retry")) {
      const msg =
        typeof parsed["message"] === "string" ? parsed["message"] : JSON.stringify(parsed);
      return {
        events: [{ t: "subagent.event", subagentId, kind: "status", chunk: msg }],
      };
    }

    // Content deltas, assistant messages, and everything else -> stdout
    const chunk = extractTextContent(parsed) ?? JSON.stringify(parsed);
    return {
      events: [{ t: "subagent.event", subagentId, kind: "stdout", chunk }],
    };
  }

  finalize(subagentId: string, exitCode: number): ParsedChunk {
    return {
      events: [{ t: "subagent.end", subagentId, ok: exitCode === 0, exit: exitCode }],
    };
  }
}

// ─── Codex exec parser ──────────────────────────────────────────────────────
//
// `codex exec --json` stability is uncertain. This parser attempts JSON
// parsing per line. If the output isn't valid JSON, it falls back to raw text.
// TODO: Revisit when codex CLI stabilizes its JSON output format.

export class CodexExecParser implements StreamParser {
  readonly name = "codex-exec";

  parseLine(subagentId: string, line: string): ParsedChunk {
    const trimmed = line.trim();
    if (trimmed.length === 0) return { events: [] };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Raw-text fallback when JSON isn't stable
      return {
        events: [{ t: "subagent.event", subagentId, kind: "stdout", chunk: line }],
      };
    }

    const type = typeof parsed["type"] === "string" ? parsed["type"] : "";

    if (type === "completed" || type === "done") {
      const ok = typeof parsed["exit_code"] === "number" ? parsed["exit_code"] === 0 : true;
      const exit = typeof parsed["exit_code"] === "number" ? parsed["exit_code"] : 0;
      return {
        events: [{ t: "subagent.end", subagentId, ok, exit }],
      };
    }

    if (type === "error") {
      const msg =
        typeof parsed["message"] === "string" ? parsed["message"] : JSON.stringify(parsed);
      return {
        events: [{ t: "subagent.event", subagentId, kind: "stderr", chunk: msg }],
      };
    }

    // Status updates, progress, etc.
    const chunk = extractTextContent(parsed) ?? JSON.stringify(parsed);
    return {
      events: [{ t: "subagent.event", subagentId, kind: "stdout", chunk }],
    };
  }

  finalize(subagentId: string, exitCode: number): ParsedChunk {
    return {
      events: [{ t: "subagent.end", subagentId, ok: exitCode === 0, exit: exitCode }],
    };
  }
}

// ─── Parser registry ────────────────────────────────────────────────────────

const PARSERS: Record<string, () => StreamParser> = {
  "raw-text": () => new RawTextParser(),
  "claude-code-stream": () => new ClaudeCodeStreamParser(),
  "codex-exec": () => new CodexExecParser(),
};

export function createParser(name: string): StreamParser {
  const factory = PARSERS[name];
  if (!factory) {
    throw new Error(`Unknown parser: ${name}. Available: ${Object.keys(PARSERS).join(", ")}`);
  }
  return factory();
}

export function availableParsers(): readonly string[] {
  return Object.keys(PARSERS);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractTextContent(obj: Record<string, unknown>): string | undefined {
  // Try common content fields across LLM CLI outputs
  if (typeof obj["content"] === "string") return obj["content"];
  if (typeof obj["text"] === "string") return obj["text"];
  if (typeof obj["message"] === "string") return obj["message"];
  if (
    typeof obj["delta"] === "object" &&
    obj["delta"] !== null &&
    typeof (obj["delta"] as Record<string, unknown>)["text"] === "string"
  ) {
    return (obj["delta"] as Record<string, unknown>)["text"] as string;
  }
  return undefined;
}
