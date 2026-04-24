import type { CockpitEvent, Message } from "./events";

export interface Transcript {
  readonly sessionId: string;
  append(message: Message): Promise<void>;
  appendDelta(messageId: string, chunk: string): Promise<void>;
  list(): Promise<readonly Message[]>;
  events(): AsyncIterable<CockpitEvent>;
}
