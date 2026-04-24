import { COCKPIT_PROTOCOL_HEADER, COCKPIT_PROTOCOL_VERSION } from "../core";

export const WEB_COCKPIT_RENDERER = {
  name: "web",
  protocolVersion: COCKPIT_PROTOCOL_VERSION,
} as const;

export const COCKPIT_SSE_PATH = "/events";
export const COCKPIT_INPUT_PATH = "/input";
export const COCKPIT_COMMAND_PATH_PREFIX = "/commands";
export const COCKPIT_SSE_HEADERS = {
  [COCKPIT_PROTOCOL_HEADER]: String(COCKPIT_PROTOCOL_VERSION),
} as const;

export {
  COCKPIT_TOKEN_HEADER,
  generateCockpitToken,
  isLoopbackAddress,
  verifyToken,
} from "./auth";
export { createCockpitApp } from "./server";
export type { CockpitServerOptions } from "./server";
export { connectSSE } from "./sse-client";
export type { SSEClient, SSEClientOptions } from "./sse-client";
export {
  initialTranscriptState,
  reduceTranscriptEvent,
  replayEvents,
} from "./transcript-reducer";
export type {
  BudgetWarningEntry,
  ErrorEntry,
  PolicyGateEntry,
  SkillProposalEntry,
  SubagentEntry,
  ToolCallEntry,
  TranscriptMessage,
  TranscriptState,
} from "./transcript-reducer";
