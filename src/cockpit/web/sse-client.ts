/**
 * Fetch-based SSE client for the cockpit web renderer.
 *
 * Uses fetch + ReadableStream instead of native EventSource so we can pass the
 * cockpit token via a custom header (EventSource only supports query params).
 *
 * This module is browser-compatible — no Node imports.
 */

import type { CockpitEvent } from "../core/events";
import { COCKPIT_TOKEN_HEADER } from "./auth";

export interface SSEClientOptions {
  readonly url: string;
  readonly token: string;
  readonly onEvent: (event: CockpitEvent) => void;
  readonly onError?: (error: Error) => void;
  readonly onOpen?: () => void;
}

export interface SSEClient {
  close(): void;
}

export function connectSSE(opts: SSEClientOptions): SSEClient {
  const ac = new AbortController();

  const run = async (): Promise<void> => {
    const response = await fetch(opts.url, {
      headers: {
        [COCKPIT_TOKEN_HEADER]: opts.token,
        Accept: "text/event-stream",
      },
      signal: ac.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${String(response.status)}`);
    }

    opts.onOpen?.();

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            opts.onEvent(JSON.parse(data) as CockpitEvent);
          } catch {
            // skip malformed events
          }
        }
      }
    }
  };

  run().catch((err: unknown) => {
    if (!ac.signal.aborted) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return {
    close(): void {
      ac.abort();
    },
  };
}
