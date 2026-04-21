import { createServer } from "node:http";
import { URL } from "node:url";
import { credentials } from "@/auth";
import { env } from "@/config";
import { TwitterApi } from "twitter-api-v2";

/**
 * One-shot OAuth 2.0 PKCE flow for X. Captures access + refresh tokens and
 * writes them into the configured credential store (env by default; file when
 * `STRAND_CREDENTIAL_STORE=file`). Re-run whenever scopes change.
 *
 * The store's `setMany()` is atomic — access + refresh + expiry land together
 * or not at all. Losing the rotated refresh token after the access succeeds
 * would otherwise lock the account out.
 */

const SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "follows.read",
  "follows.write",
  "offline.access",
  "like.read",
  "like.write",
  "bookmark.read",
  "bookmark.write",
  "dm.read",
  "dm.write",
];

async function main(): Promise<void> {
  const store = credentials();
  const clientId = (await store.get("X_CLIENT_ID")) ?? env.X_CLIENT_ID;
  const clientSecret = (await store.get("X_CLIENT_SECRET")) ?? env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    process.stdout.write(
      "X_CLIENT_ID / X_CLIENT_SECRET missing from credential store AND .env — " +
        "set one of them before running `pnpm oauth:setup`.\n",
    );
    process.exit(2);
  }

  const oauth = new TwitterApi({ clientId, clientSecret });
  const redirectUri = env.X_OAUTH_REDIRECT_URI;

  const { url, codeVerifier, state } = oauth.generateOAuth2AuthLink(redirectUri, {
    scope: SCOPES,
  });

  process.stdout.write(
    `\nOpen this URL in a browser logged in as the Strand account:\n\n${url}\n\n`,
  );

  const port = Number(new URL(redirectUri).port || "4567");
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", redirectUri);
    const code = reqUrl.searchParams.get("code");
    const rState = reqUrl.searchParams.get("state");
    if (!code || rState !== state) {
      res.writeHead(400).end("missing code/state mismatch");
      return;
    }
    try {
      const { accessToken, refreshToken, expiresIn } = await oauth.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri,
      });

      const me = await new TwitterApi(accessToken).v2.me();

      const updates: Record<string, string> = {
        X_USER_ID: me.data.id,
        X_USER_ACCESS_TOKEN: accessToken,
        X_USER_TOKEN_EXPIRES_AT: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
      if (refreshToken) updates["X_USER_REFRESH_TOKEN"] = refreshToken;

      if (store.setMany) {
        await store.setMany(updates);
      } else {
        for (const [k, v] of Object.entries(updates)) await store.set(k, v);
      }

      res.writeHead(200).end(`ok — captured tokens for @${me.data.username}`);
      process.stdout.write(`\ncaptured tokens for @${me.data.username} (id=${me.data.id})\n`);
      process.stdout.write(`tokens written to credential store: ${store.name}\n`);
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      res.writeHead(500).end(`error: ${String(err)}`);
      process.stdout.write(`\nerror: ${String(err)}\n`);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    process.stdout.write(`waiting for callback on ${redirectUri} ...\n`);
  });
}

void main();
