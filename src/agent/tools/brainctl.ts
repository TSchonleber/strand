/**
 * Local Tool wrappers over brain read helpers. Let the Plan Runner query
 * brainctl directly without routing through an LLM MCP allowlist.
 */

import { brain } from "@/clients/brain";
import type { Tool } from "../types";

export interface BrainMemorySearchArgs {
  query: string;
  limit?: number;
  scope?: string;
  tier?: string;
}
export interface BrainMemorySearchResult {
  results: unknown[];
}

export function makeBrainMemorySearch(): Tool<BrainMemorySearchArgs, BrainMemorySearchResult> {
  return {
    name: "brain_memory_search",
    description: "Search brainctl memories (read-only).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        scope: { type: "string" },
        tier: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args) {
      const payload: { query: string; limit?: number; scope?: string; tier?: string } = {
        query: args.query,
      };
      if (args.limit !== undefined) payload.limit = args.limit;
      if (args.scope !== undefined) payload.scope = args.scope;
      if (args.tier !== undefined) payload.tier = args.tier;
      return brain.memory_search(payload);
    },
  };
}

export interface BrainEntityGetArgs {
  entity_id?: string;
  identifier?: string;
  handle?: string;
}
export interface BrainEntityGetResult {
  entity: unknown;
}

export function makeBrainEntityGet(): Tool<BrainEntityGetArgs, BrainEntityGetResult> {
  return {
    name: "brain_entity_get",
    description: "Fetch a single brainctl entity by id / identifier / handle.",
    parameters: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        identifier: { type: "string" },
        handle: { type: "string" },
      },
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args) {
      const payload: { entity_id?: string; identifier?: string; handle?: string } = {};
      if (args.entity_id !== undefined) payload.entity_id = args.entity_id;
      if (args.identifier !== undefined) payload.identifier = args.identifier;
      if (args.handle !== undefined) payload.handle = args.handle;
      return brain.entity_get(payload);
    },
  };
}
