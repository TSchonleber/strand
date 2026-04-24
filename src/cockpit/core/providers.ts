import type { LlmProvider } from "@/clients/llm";
import type { ProviderId } from "./events";

export type AuthType = "api_key" | "oauth_device_code" | "oauth_external";

export interface ProviderSelection {
  id: ProviderId;
  model: string;
  authType: AuthType;
  source: "env" | "strand_store" | "external_cli" | "openai_compat";
}

export interface ProviderRouter {
  active(): Promise<ProviderSelection | null>;
  switchProvider(next: ProviderSelection): Promise<void>;
  providerFor(selection: ProviderSelection): Promise<LlmProvider>;
}
