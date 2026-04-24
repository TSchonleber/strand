import { COCKPIT_PROTOCOL_VERSION } from "../core";

export const INK_COCKPIT_RENDERER = {
  name: "ink",
  protocolVersion: COCKPIT_PROTOCOL_VERSION,
} as const;

export { createInkBridge, createSkillEventBridge } from "./bridge";
export type { InkBridge, InkBridgeOpts, InkEventHandler, SkillReviewItem } from "./bridge";
