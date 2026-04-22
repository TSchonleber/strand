import { createServer } from "node:http";
import { URL } from "node:url";
import type { Command } from "commander";
import type { CliContext } from "../index";
import { printLine } from "../util/output";

const X_SCOPES = [
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

export function registerOauthCmd(program: Command, _ctx: CliContext): void {
  program
    .command("oauth")
    .description("run an OAuth 2.0 PKCE flow for a provider and persist the tokens")
    .argument("<provider>", "currently only `x` is supported")
    .action(async (provider: string) => {
      if (provider !== "x") {
        process.stderr.write(`oauth: provider "${provider}" not yet supported\n`);
        process.exit(2);
      }
      await runXOauth();
    });
}

async function runXOauth(): Promise<void> {
  const { credentials } = await import("@/auth");
  const { env } = await import("@/config");
  const { TwitterApi } = await import("twitter-api-v2");

  const store = credentials();
  const clientId = (await store.get("X_CLIENT_ID")) ?? env.X_CLIENT_ID;
  const clientSecret = (await store.get("X_CLIENT_SECRET")) ?? env.X_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    process.stderr.write(
      "X_CLIENT_ID / X_CLIENT_SECRET missing from credential store AND .env — set one before running `strand oauth x`.\n",
    );
    process.exit(2);
  }

  const oauth = new TwitterApi({ clientId, clientSecret });
  const redirectUri = env.X_OAUTH_REDIRECT_URI;

  const { url, codeVerifier, state } = oauth.generateOAuth2AuthLink(redirectUri, {
    scope: X_SCOPES,
  });

  printLine(`\nOpen this URL in a browser logged in as the Strand account:\n\n${url}\n`);

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
      printLine(`\ncaptured tokens for @${me.data.username} (id=${me.data.id})`);
      printLine(`tokens written to credential store: ${store.name}`);
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      res.writeHead(500).end(`error: ${String(err)}`);
      process.stderr.write(`\nerror: ${String(err)}\n`);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    printLine(`waiting for callback on ${redirectUri} ...`);
  });
}
