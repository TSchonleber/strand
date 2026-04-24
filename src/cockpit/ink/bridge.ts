/**
 * Ink renderer bridge — minimal adapter for a future chat-first Ink renderer
 * to consume CockpitEvent streams from the core EventBus.
 *
 * This does NOT replace the classic gamified TUI (`strand tui --classic`).
 * It provides the plumbing so a chat-oriented Ink UI can subscribe to the
 * same event stream that the web renderer uses.
 *
 * Design constraints (from §7):
 * - Preserve current gamified TUI as "classic"
 * - Do not make telemetry default chat context
 * - Both renderers consume the identical CockpitEvent schema
 */

import type { SkillRecord } from "../../agent/skills/lifecycle";
import type { CockpitEvent, CockpitEventType, EventBus } from "../core/events";

export interface InkBridgeOpts {
  bus: EventBus;
  filter?: CockpitEventType[];
}

export type InkEventHandler = (event: CockpitEvent) => void;

export interface SkillReviewItem {
  skillName: string;
  proposalKind: "draft" | "retire";
  proposalId: string;
  rationale: string;
  record: SkillRecord | null;
}

/**
 * Lightweight bridge that connects the core EventBus to an Ink renderer.
 *
 * Usage:
 *   const bridge = createInkBridge({ bus });
 *   bridge.onEvent((event) => { ... render in Ink ... });
 *   // later:
 *   bridge.destroy();
 */
export interface InkBridge {
  onEvent(handler: InkEventHandler): void;
  destroy(): void;
  readonly active: boolean;
}

export function createInkBridge(opts: InkBridgeOpts): InkBridge {
  const { bus, filter } = opts;
  const handlers: InkEventHandler[] = [];
  let destroyed = false;

  const listener = (event: CockpitEvent): void => {
    if (destroyed) return;
    if (filter && !filter.includes(event.t)) return;
    for (const h of handlers) {
      h(event);
    }
  };

  const unsubscribe = bus.subscribe(listener);

  return {
    onEvent(handler: InkEventHandler): void {
      if (destroyed) return;
      handlers.push(handler);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      handlers.length = 0;
      unsubscribe();
    },
    get active(): boolean {
      return !destroyed;
    },
  };
}

/**
 * Create a bridge filtered to skill-lifecycle events only.
 * Useful for the skill review feed in the chat-first UI.
 */
export function createSkillEventBridge(bus: EventBus): InkBridge {
  return createInkBridge({
    bus,
    filter: ["skill.proposal", "skill.decision"],
  });
}
