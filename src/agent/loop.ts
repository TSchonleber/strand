/**
 * Agentic loop runner.
 *
 * Provider-agnostic chat → tool → chat driver. Merges caller-declared local
 * function tools with provider-native tools, dispatches tool calls either
 * locally (for `LocalTool`s), to a `ComputerExecutor` (for computer-use /
 * bash / text-editor), or records an `unknown_tool` error result so the
 * model can recover. Bounded by `maxIterations`, cancellable via
 * `AbortSignal`. Sums usage across iterations, keeps a trace.
 *
 * Pure orchestration — no adapter internals, no policy gating, no X/brainctl
 * side effects. Callers plug those in via tools + executor.
 */

import type { LlmProvider } from "@/clients/llm";
import type { LlmCall, LlmMessage, LlmResult, LlmTool, LlmUsage } from "@/clients/llm";
import type { LlmFunctionTool, LlmToolCall } from "@/clients/llm/types";
import type { ContextEngine } from "./context-engine";
import type { ComputerExecutor, MouseButton, ScrollDirection } from "./executor";

export interface LocalTool<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  /** JSON schema describing args. */
  parameters: Record<string, unknown>;
  execute(args: TArgs, ctx: LoopContext): Promise<TResult>;
  /** Optional per-call gate hook. Throw to reject. */
  gate?(args: TArgs, ctx: LoopContext): Promise<void> | void;
}

export interface LoopTraceEntry {
  at: number;
  event: "chat_call" | "tool_call" | "tool_result" | "stop" | "abort" | "error";
  detail: Record<string, unknown>;
}

export interface LoopContext {
  provider: LlmProvider;
  executor?: ComputerExecutor;
  signal?: AbortSignal;
  trace: LoopTraceEntry[];
  metadata?: Record<string, unknown>;
}

export interface LoopInput extends Omit<LlmCall, "tools"> {
  tools?: LlmTool[];
  localTools?: LocalTool[];
  /** Cap on loop iterations (chat calls). Default: 10. */
  maxIterations?: number;
  onIteration?(iter: number, result: LlmResult): void | Promise<void>;
  /** Supplies the provider. */
  provider: LlmProvider;
  /** Executor for computer-use / bash / text-editor tool calls. */
  executor?: ComputerExecutor;
  /** Abort mid-loop. Checked between iterations. */
  signal?: AbortSignal;
  /**
   * Optional context compactor. Called before each chat() once the conversation
   * has grown. Preserves the leading system/tool prefix for cache hygiene.
   * Default: no compaction.
   */
  contextEngine?: ContextEngine;
  metadata?: Record<string, unknown>;
}

export type LoopStopReason = "text_complete" | "max_iterations" | "abort" | "error";

export interface LoopOutput {
  finalText: string;
  finalResponseId: string;
  iterations: number;
  usage: LlmUsage;
  toolCallsTotal: number;
  stopReason: LoopStopReason;
  messages: LlmMessage[];
  trace: LoopTraceEntry[];
}

const DEFAULT_MAX_ITERATIONS = 10;

const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costInUsdTicks: 0,
};

function sumUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costInUsdTicks: a.costInUsdTicks + b.costInUsdTicks,
  };
}

function toFunctionTool(t: LocalTool): LlmFunctionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

function stringifyResult(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return {};
}

async function dispatchComputer(
  executor: ComputerExecutor,
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = typeof args["action"] === "string" ? args["action"] : "";
  switch (action) {
    case "screenshot":
      return executor.screenshot();
    case "cursor_position":
      return executor.cursorPosition();
    case "mouse_move": {
      const [x, y] = readCoordinate(args);
      await executor.mouseMove(x, y);
      return { ok: true };
    }
    case "left_click":
    case "right_click":
    case "middle_click": {
      const [x, y] = readCoordinate(args);
      const button: MouseButton =
        action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      await executor.click(x, y, button);
      return { ok: true };
    }
    case "double_click": {
      const [x, y] = readCoordinate(args);
      await executor.doubleClick(x, y);
      return { ok: true };
    }
    case "type": {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      await executor.type(text);
      return { ok: true };
    }
    case "key": {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      await executor.key(text);
      return { ok: true };
    }
    case "scroll": {
      const [x, y] = readCoordinate(args);
      const direction =
        typeof args["scroll_direction"] === "string"
          ? (args["scroll_direction"] as ScrollDirection)
          : "down";
      const amount = typeof args["scroll_amount"] === "number" ? args["scroll_amount"] : 1;
      await executor.mouseMove(x, y);
      await executor.scroll(direction, amount);
      return { ok: true };
    }
    case "wait": {
      const duration = typeof args["duration"] === "number" ? args["duration"] : 1;
      await executor.wait(duration);
      return { ok: true };
    }
    default:
      throw new Error(`unsupported computer action: ${action}`);
  }
}

function readCoordinate(args: Record<string, unknown>): [number, number] {
  const coord = args["coordinate"];
  if (Array.isArray(coord) && coord.length >= 2) {
    const x = typeof coord[0] === "number" ? coord[0] : 0;
    const y = typeof coord[1] === "number" ? coord[1] : 0;
    return [x, y];
  }
  const x = typeof args["x"] === "number" ? args["x"] : 0;
  const y = typeof args["y"] === "number" ? args["y"] : 0;
  return [x, y];
}

async function dispatchBash(
  executor: ComputerExecutor,
  args: Record<string, unknown>,
): Promise<unknown> {
  const command = typeof args["command"] === "string" ? args["command"] : "";
  return executor.bash(command);
}

async function dispatchTextEditor(
  executor: ComputerExecutor,
  args: Record<string, unknown>,
): Promise<unknown> {
  const command = typeof args["command"] === "string" ? args["command"] : "view";
  return executor.textEditor(command as never, args);
}

function isComputerUseName(name: string): boolean {
  return (
    name === "computer" ||
    name.startsWith("bash") ||
    name === "str_replace_editor" ||
    name === "text_editor" ||
    name.startsWith("text_editor")
  );
}

export async function runAgenticLoop(input: LoopInput): Promise<LoopOutput> {
  const {
    provider,
    executor,
    signal,
    metadata,
    localTools = [],
    tools: providerTools = [],
    maxIterations = DEFAULT_MAX_ITERATIONS,
    onIteration,
    contextEngine,
    ...rest
  } = input;

  const localByName = new Map<string, LocalTool>();
  for (const t of localTools) localByName.set(t.name, t);

  const mergedTools: LlmTool[] = [...providerTools, ...localTools.map(toFunctionTool)];

  const trace: LoopTraceEntry[] = [];
  const ctx: LoopContext = {
    provider,
    ...(executor !== undefined ? { executor } : {}),
    ...(signal !== undefined ? { signal } : {}),
    trace,
    ...(metadata !== undefined ? { metadata } : {}),
  };

  let messages: LlmMessage[] = [...rest.messages];

  let usage: LlmUsage = { ...EMPTY_USAGE };
  let lastUsage: LlmUsage | null = null;
  let iterations = 0;
  let toolCallsTotal = 0;
  let finalText = "";
  let finalResponseId = "";
  let stopReason: LoopStopReason = "text_complete";

  while (iterations < maxIterations) {
    if (signal?.aborted) {
      stopReason = "abort";
      trace.push({ at: Date.now(), event: "abort", detail: { iterations } });
      break;
    }

    // Compact before each chat if an engine is plugged in. Happens AFTER the
    // first iteration (lastUsage is null on the first call — nothing to base
    // a threshold on yet).
    if (contextEngine && lastUsage) {
      try {
        const r = await contextEngine.maybeCompress({ messages, lastUsage, provider });
        if (r.compressed) {
          messages = r.messages;
          trace.push({
            at: Date.now(),
            event: "tool_result",
            detail: {
              id: "context.compact",
              name: contextEngine.name,
              removed: r.removed,
              estimatedTokensAfter: r.estimatedTokens,
            },
          });
        }
      } catch (err) {
        // Compaction failure is not fatal — log + continue with the original
        // messages and let the provider reject with context-overflow if that's
        // what happens.
        trace.push({
          at: Date.now(),
          event: "error",
          detail: { error: err instanceof Error ? err.message : String(err), phase: "compact" },
        });
      }
    }

    const callArgs: LlmCall = {
      ...rest,
      messages,
      ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
    };

    trace.push({
      at: Date.now(),
      event: "chat_call",
      detail: { iteration: iterations, messageCount: messages.length },
    });

    let result: LlmResult;
    try {
      result = await provider.chat(callArgs);
    } catch (err) {
      stopReason = "error";
      trace.push({
        at: Date.now(),
        event: "error",
        detail: { iteration: iterations, error: err instanceof Error ? err.message : String(err) },
      });
      break;
    }

    iterations += 1;
    usage = sumUsage(usage, result.usage);
    lastUsage = result.usage;
    finalText = result.outputText;
    finalResponseId = result.responseId;

    if (onIteration) {
      await onIteration(iterations, result);
    }

    if (result.toolCalls.length === 0) {
      stopReason = "text_complete";
      trace.push({
        at: Date.now(),
        event: "stop",
        detail: { reason: "text_complete", iterations },
      });
      break;
    }

    const normalizedCalls: LlmToolCall[] = result.toolCalls.map((call, i) => ({
      ...call,
      id: call.id ?? `fc-${iterations}-${i}`,
    }));

    messages.push({
      role: "assistant",
      content: result.outputText,
      toolCalls: normalizedCalls,
    });

    const dispatches = normalizedCalls.map(async (call) => {
      const callId = call.id ?? "fc-unknown";
      trace.push({
        at: Date.now(),
        event: "tool_call",
        detail: { id: callId, name: call.name },
      });

      let content: string;
      try {
        if (localByName.has(call.name)) {
          const tool = localByName.get(call.name) as LocalTool;
          const args = call.args;
          if (tool.gate) {
            await tool.gate(args, ctx);
          }
          const out = await tool.execute(args, ctx);
          content = stringifyResult(out);
        } else if (isComputerUseName(call.name)) {
          if (!executor) {
            throw new Error(`no executor configured for computer-use tool: ${call.name}`);
          }
          const args = coerceArgs(call.args);
          let out: unknown;
          if (call.name === "computer") {
            out = await dispatchComputer(executor, args);
          } else if (call.name.startsWith("bash")) {
            out = await dispatchBash(executor, args);
          } else {
            out = await dispatchTextEditor(executor, args);
          }
          content = stringifyResult(out);
        } else {
          content = stringifyResult({ error: `unknown_tool:${call.name}` });
        }
      } catch (err) {
        content = stringifyResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }

      trace.push({
        at: Date.now(),
        event: "tool_result",
        detail: { id: callId, name: call.name, contentPreview: content.slice(0, 200) },
      });

      return { toolCallId: callId, content };
    });

    const results = await Promise.all(dispatches);
    toolCallsTotal += normalizedCalls.length;

    for (const r of results) {
      messages.push({ role: "tool", toolCallId: r.toolCallId, content: r.content });
    }

    if (signal?.aborted) {
      stopReason = "abort";
      trace.push({ at: Date.now(), event: "abort", detail: { iterations } });
      break;
    }
  }

  if (iterations >= maxIterations && stopReason === "text_complete") {
    // Ran out of iterations while still having tool calls pending.
    // stopReason stays text_complete only if the last iteration had no tool calls.
    // If we fell through the while-condition with tool calls queued, mark max_iterations.
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === "tool") {
      stopReason = "max_iterations";
      trace.push({
        at: Date.now(),
        event: "stop",
        detail: { reason: "max_iterations", iterations },
      });
    }
  }

  return {
    finalText,
    finalResponseId,
    iterations,
    usage,
    toolCallsTotal,
    stopReason,
    messages,
    trace,
  };
}
