import {
  ClaudeCodeStreamParser,
  CodexExecParser,
  RawTextParser,
  availableParsers,
  createParser,
} from "@/cockpit/subagents/parsers";
import { describe, expect, it } from "vitest";

const SID = "subagent-test";

describe("RawTextParser", () => {
  const parser = new RawTextParser();

  it("emits stdout event for each line", () => {
    const { events } = parser.parseLine(SID, "hello world");
    expect(events).toEqual([
      { t: "subagent.event", subagentId: SID, kind: "stdout", chunk: "hello world" },
    ]);
  });

  it("finalize emits subagent.end with ok=true on exit 0", () => {
    const { events } = parser.finalize(SID, 0);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: true, exit: 0 }]);
  });

  it("finalize emits subagent.end with ok=false on non-zero exit", () => {
    const { events } = parser.finalize(SID, 1);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: false, exit: 1 }]);
  });
});

describe("ClaudeCodeStreamParser", () => {
  const parser = new ClaudeCodeStreamParser();

  it("parses result event as subagent.end", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: false,
      session_id: "abc",
      total_cost_usd: 0.01,
    });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: true, exit: 0 }]);
  });

  it("parses error result as subagent.end with ok=false", () => {
    const line = JSON.stringify({ type: "result", is_error: true });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: false, exit: 1 }]);
  });

  it("parses system event as status", () => {
    const line = JSON.stringify({ type: "system", message: "retrying..." });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([
      { t: "subagent.event", subagentId: SID, kind: "status", chunk: "retrying..." },
    ]);
  });

  it("parses api_retry event as status", () => {
    const line = JSON.stringify({ type: "api_retry", message: "rate limited" });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([
      { t: "subagent.event", subagentId: SID, kind: "status", chunk: "rate limited" },
    ]);
  });

  it("parses content delta as stdout", () => {
    const line = JSON.stringify({ type: "content_block_delta", delta: { text: "hello" } });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([
      { t: "subagent.event", subagentId: SID, kind: "stdout", chunk: "hello" },
    ]);
  });

  it("falls back to raw text on invalid JSON", () => {
    const { events } = parser.parseLine(SID, "not json at all");
    expect(events).toEqual([
      { t: "subagent.event", subagentId: SID, kind: "stdout", chunk: "not json at all" },
    ]);
  });

  it("skips empty lines", () => {
    const { events } = parser.parseLine(SID, "   ");
    expect(events).toEqual([]);
  });

  it("finalize emits subagent.end", () => {
    const { events } = parser.finalize(SID, 0);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: true, exit: 0 }]);
  });
});

describe("CodexExecParser", () => {
  const parser = new CodexExecParser();

  it("parses completed event as subagent.end", () => {
    const line = JSON.stringify({ type: "completed", exit_code: 0 });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: true, exit: 0 }]);
  });

  it("parses completed with non-zero exit as failed", () => {
    const line = JSON.stringify({ type: "completed", exit_code: 1 });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: false, exit: 1 }]);
  });

  it("parses done event as subagent.end", () => {
    const line = JSON.stringify({ type: "done" });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([{ t: "subagent.end", subagentId: SID, ok: true, exit: 0 }]);
  });

  it("parses error event as stderr", () => {
    const line = JSON.stringify({ type: "error", message: "something broke" });
    const { events } = parser.parseLine(SID, line);
    expect(events).toEqual([
      { t: "subagent.event", subagentId: SID, kind: "stderr", chunk: "something broke" },
    ]);
  });

  it("falls back to raw text on non-JSON", () => {
    const { events } = parser.parseLine(SID, "plain text output");
    expect(events).toEqual([
      { t: "subagent.event", subagentId: SID, kind: "stdout", chunk: "plain text output" },
    ]);
  });

  it("skips empty lines", () => {
    const { events } = parser.parseLine(SID, "");
    expect(events).toEqual([]);
  });
});

describe("createParser", () => {
  it("creates raw-text parser", () => {
    const p = createParser("raw-text");
    expect(p.name).toBe("raw-text");
  });

  it("creates claude-code-stream parser", () => {
    const p = createParser("claude-code-stream");
    expect(p.name).toBe("claude-code-stream");
  });

  it("creates codex-exec parser", () => {
    const p = createParser("codex-exec");
    expect(p.name).toBe("codex-exec");
  });

  it("throws on unknown parser", () => {
    expect(() => createParser("nonexistent")).toThrow("Unknown parser: nonexistent");
  });
});

describe("availableParsers", () => {
  it("returns all registered parsers", () => {
    const parsers = availableParsers();
    expect(parsers).toContain("raw-text");
    expect(parsers).toContain("claude-code-stream");
    expect(parsers).toContain("codex-exec");
  });
});
