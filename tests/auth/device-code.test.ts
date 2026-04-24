import {
  DeviceCodeError,
  type DeviceCodeHttpClient,
  type TokenPollResult,
  type TokenSet,
  type UserCodeResponse,
  runDeviceCodeFlow,
} from "@/auth/device-code";
import { describe, expect, it, vi } from "vitest";

function makeMockClient(opts?: {
  pendingPolls?: number;
  failExchange?: boolean;
}): DeviceCodeHttpClient {
  const pendingPolls = opts?.pendingPolls ?? 1;
  let pollCount = 0;

  return {
    async requestUserCode(_clientId: string): Promise<UserCodeResponse> {
      return {
        user_code: "ABCD-1234",
        device_auth_id: "dev-auth-42",
        interval: 0,
      };
    },

    async pollToken(_deviceAuthId: string, _userCode: string): Promise<TokenPollResult> {
      pollCount++;
      if (pollCount <= pendingPolls) {
        return { status: "pending" };
      }
      return {
        status: "success",
        data: {
          authorization_code: "auth-code-xyz",
          code_verifier: "verifier-abc",
        },
      };
    },

    async exchangeToken(_params: {
      authorizationCode: string;
      codeVerifier: string;
      clientId: string;
      redirectUri: string;
    }): Promise<TokenSet> {
      if (opts?.failExchange) {
        throw new DeviceCodeError("exchange failed");
      }
      return {
        access_token: "at-final",
        refresh_token: "rt-final",
        id_token: "id-final",
        expires_in: 3600,
      };
    },
  };
}

describe("device-code flow", () => {
  it("completes with mocked HTTP endpoints", async () => {
    const client = makeMockClient({ pendingPolls: 2 });
    const onUserCode = vi.fn();

    const tokens = await runDeviceCodeFlow({
      client,
      clientId: "test-client-id",
      onUserCode,
      _minPollIntervalMs: 10,
    });

    expect(onUserCode).toHaveBeenCalledOnce();
    expect(onUserCode).toHaveBeenCalledWith({
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    });

    expect(tokens.access_token).toBe("at-final");
    expect(tokens.refresh_token).toBe("rt-final");
    expect(tokens.expires_in).toBe(3600);
  });

  it("resolves immediately when first poll succeeds", async () => {
    const client = makeMockClient({ pendingPolls: 0 });
    const onUserCode = vi.fn();

    const tokens = await runDeviceCodeFlow({
      client,
      clientId: "test-client-id",
      onUserCode,
      _minPollIntervalMs: 10,
    });

    expect(tokens.access_token).toBe("at-final");
  });

  it("propagates exchange errors", async () => {
    const client = makeMockClient({ pendingPolls: 0, failExchange: true });
    const onUserCode = vi.fn();

    await expect(
      runDeviceCodeFlow({
        client,
        clientId: "test-client-id",
        onUserCode,
        _minPollIntervalMs: 10,
      }),
    ).rejects.toThrow(DeviceCodeError);
  });

  it("calls onUserCode with the correct user code", async () => {
    const client = makeMockClient();
    const onUserCode = vi.fn();

    await runDeviceCodeFlow({
      client,
      clientId: "my-client",
      onUserCode,
      _minPollIntervalMs: 10,
    });

    expect(onUserCode.mock.calls[0]?.[0]).toEqual({
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
  });
});
