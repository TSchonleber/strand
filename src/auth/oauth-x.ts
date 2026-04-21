import { log } from "@/util/log";
import { TwitterApi } from "twitter-api-v2";
import type { CredentialStore } from "./credentials";
import type { OAuthProviderStrategy } from "./oauth-store";

/**
 * X / Twitter OAuth 2.0 PKCE strategy.
 *
 * X rotates the refresh token on every refresh — lose the new one and the
 * account locks out of automated writes until a manual re-auth. The store's
 * atomic `setMany()` is non-negotiable for this flow.
 *
 * Scopes requested by `oauth-setup`:
 *   tweet.read users.read tweet.write like.write follows.write
 *   dm.read dm.write list.write mute.write block.write bookmark.write
 *   offline.access
 */
export function makeXOAuthStrategy(args: {
  store: CredentialStore;
}): OAuthProviderStrategy {
  return {
    name: "x",
    accessTokenKey: "X_USER_ACCESS_TOKEN",
    refreshTokenKey: "X_USER_REFRESH_TOKEN",
    expiresAtKey: "X_USER_TOKEN_EXPIRES_AT",
    refreshWindowSeconds: 60,
    async refresh({ refreshToken }) {
      const clientId = await args.store.get("X_CLIENT_ID");
      const clientSecret = await args.store.get("X_CLIENT_SECRET");
      if (!clientId || !clientSecret) {
        throw new Error(
          "X OAuth refresh requires X_CLIENT_ID + X_CLIENT_SECRET in the credential store",
        );
      }
      const oauth = new TwitterApi({ clientId, clientSecret });
      const result = await oauth.refreshOAuth2Token(refreshToken);
      log.debug(
        {
          svc: "auth",
          provider: "x",
          expires_in: result.expiresIn,
          rotated: Boolean(result.refreshToken),
        },
        "auth.oauth.x.refresh_success",
      );
      const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
      const out: {
        accessToken: string;
        refreshToken?: string;
        expiresAt: string;
      } = {
        accessToken: result.accessToken,
        expiresAt,
      };
      if (result.refreshToken) out.refreshToken = result.refreshToken;
      return out;
    },
  };
}
