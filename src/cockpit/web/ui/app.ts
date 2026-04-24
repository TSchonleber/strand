/**
 * Web cockpit application entry point.
 *
 * When bundled by Vite this replaces the inline <script> in index.html.
 * Imports the typed SSE client and transcript reducer so the browser gets
 * full CockpitEvent handling with the same state machine used by parity tests.
 */

import type { CockpitEvent } from "../../core/events";
import type { SSEClient } from "../sse-client";
import type { TranscriptState } from "../transcript-reducer";

export interface AppConfig {
  readonly token: string;
  readonly sessionId: string;
  readonly eventsUrl: string;
  readonly inputUrl: string;
  readonly commandsUrl: string;
}

export function defaultConfig(search?: string): AppConfig {
  const params = new URLSearchParams(search ?? "");
  return {
    token: params.get("token") ?? "",
    sessionId: "default",
    eventsUrl: "/events",
    inputUrl: "/input",
    commandsUrl: "/commands",
  };
}

/**
 * Renders transcript state into the DOM.
 * Placeholder — production version will use a proper component framework.
 */
export function renderTranscript(_container: HTMLElement, _state: TranscriptState): void {
  // Rendering handled by inline script for now.
  // This will be replaced by a Vite-bundled React/Preact app.
}

export type { CockpitEvent, SSEClient, TranscriptState };
