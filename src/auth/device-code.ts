/**
 * OpenAI OAuth device-code flow scaffolding.
 *
 * Reference: spec S3 "Device-code flow reference (OpenAI)" and hermes
 * `_codex_device_code_login`.
 *
 * Flow:
 *   1. POST /api/accounts/deviceauth/usercode → { user_code, device_auth_id, interval }
 *   2. Show user: open https://auth.openai.com/codex/device, enter code
 *   3. Poll: POST /api/accounts/deviceauth/token → 200 { authorization_code, code_verifier } | 403/404
 *   4. Exchange: POST /oauth/token → { access_token, refresh_token, id_token, expires_in }
 *
 * Max wait 15 minutes. Poll interval >= 3s.
 *
 * The `DeviceCodeHttpClient` interface is fully mockable for CI tests.
 */

import { z } from "zod";

export const OPENAI_AUTH_BASE = "https://auth.openai.com";
export const OPENAI_DEVICE_URL = "https://auth.openai.com/codex/device";
export const DEVICE_CODE_MAX_WAIT_MS = 15 * 60 * 1000;
export const DEVICE_CODE_MIN_POLL_INTERVAL_MS = 3000;

export const UserCodeResponseSchema = z.object({
  user_code: z.string().min(1),
  device_auth_id: z.string().min(1),
  interval: z.number().int().nonnegative(),
});
export type UserCodeResponse = z.infer<typeof UserCodeResponseSchema>;

export const TokenPollSuccessSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});
export type TokenPollSuccess = z.infer<typeof TokenPollSuccessSchema>;

export const TokenSetSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().optional(),
  expires_in: z.number().int().positive(),
});
export type TokenSet = z.infer<typeof TokenSetSchema>;

export type TokenPollResult = { status: "pending" } | { status: "success"; data: TokenPollSuccess };

/**
 * HTTP-level interface for the device-code flow. Fully mockable —
 * CI tests inject a stub that returns canned responses.
 */
export interface DeviceCodeHttpClient {
  requestUserCode(clientId: string): Promise<UserCodeResponse>;
  pollToken(deviceAuthId: string, userCode: string): Promise<TokenPollResult>;
  exchangeToken(params: {
    authorizationCode: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): Promise<TokenSet>;
}

/**
 * Real HTTP client that talks to auth.openai.com.
 * Uses `fetch` (Node 22+ built-in).
 */
export class OpenAIDeviceCodeClient implements DeviceCodeHttpClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = OPENAI_AUTH_BASE) {
    this.baseUrl = baseUrl;
  }

  async requestUserCode(clientId: string): Promise<UserCodeResponse> {
    const res = await fetch(`${this.baseUrl}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
    });
    if (!res.ok) {
      throw new DeviceCodeError(`usercode request failed: ${res.status} ${res.statusText}`);
    }
    const body: unknown = await res.json();
    return UserCodeResponseSchema.parse(body);
  }

  async pollToken(deviceAuthId: string, userCode: string): Promise<TokenPollResult> {
    const res = await fetch(`${this.baseUrl}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (res.status === 403 || res.status === 404) {
      return { status: "pending" };
    }
    if (!res.ok) {
      throw new DeviceCodeError(`token poll failed: ${res.status} ${res.statusText}`);
    }
    const body: unknown = await res.json();
    return { status: "success", data: TokenPollSuccessSchema.parse(body) };
  }

  async exchangeToken(params: {
    authorizationCode: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): Promise<TokenSet> {
    const formBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    });
    const res = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    if (!res.ok) {
      throw new DeviceCodeError(`token exchange failed: ${res.status} ${res.statusText}`);
    }
    const body: unknown = await res.json();
    return TokenSetSchema.parse(body);
  }
}

export class DeviceCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceCodeError";
  }
}

/**
 * Orchestrates the full device-code flow. Calls the HTTP client, polls with
 * backoff, and returns the final token set.
 *
 * @param client   - injectable HTTP client (mock for tests)
 * @param clientId - OpenAI OAuth client ID
 * @param onUserCode - callback to display the user code + URL to the user
 */
export async function runDeviceCodeFlow(opts: {
  client: DeviceCodeHttpClient;
  clientId: string;
  redirectUri?: string;
  onUserCode: (info: { userCode: string; verificationUrl: string }) => void;
  /** Override for tests — minimum poll interval in ms. Production default: 3000. */
  _minPollIntervalMs?: number;
  /** Override for tests — max wait in ms. Production default: 15 min. */
  _maxWaitMs?: number;
}): Promise<TokenSet> {
  const { client, clientId, onUserCode } = opts;
  const redirectUri = opts.redirectUri ?? "https://auth.openai.com/codex/device/callback";
  const minPoll = opts._minPollIntervalMs ?? DEVICE_CODE_MIN_POLL_INTERVAL_MS;
  const maxWait = opts._maxWaitMs ?? DEVICE_CODE_MAX_WAIT_MS;

  const codeResponse = await client.requestUserCode(clientId);
  onUserCode({
    userCode: codeResponse.user_code,
    verificationUrl: OPENAI_DEVICE_URL,
  });

  const intervalMs = Math.max(codeResponse.interval * 1000, minPoll);
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = await client.pollToken(codeResponse.device_auth_id, codeResponse.user_code);
    if (result.status === "success") {
      return client.exchangeToken({
        authorizationCode: result.data.authorization_code,
        codeVerifier: result.data.code_verifier,
        clientId,
        redirectUri,
      });
    }
  }

  throw new DeviceCodeError("device-code flow timed out after 15 minutes");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
