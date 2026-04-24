import type { Candidate } from "@/types/actions";
import type { CockpitEvent } from "./events";

export interface ChatInput {
  sessionId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SlashCommandInput {
  sessionId: string;
  command: string;
  args: readonly string[];
}

export interface ChatController {
  submit(input: ChatInput): Promise<void>;
  slash(input: SlashCommandInput): Promise<void>;
  events(): AsyncIterable<CockpitEvent>;
}

export interface XActionProposal {
  candidate: Candidate<"proposed">;
  sourceSessionId: string;
  sourceMessageId?: string;
}
