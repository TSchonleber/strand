import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { URL } from "node:url";
import { TwitterApi } from "twitter-api-v2";
import { env } from "@/config";

/**
 * One-shot OAuth 2.0 PKCE flow. Captures access + refresh tokens and
 * writes them into the local .env. Re-run whenever scopes change.
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
  const oauth = new TwitterApi({
    clientId: env.X_CLIENT_ID,
    clientSecret: env.X_CLIENT_SECRET,
  });

  const { url, codeVerifier, state } = oauth.generateOAuth2AuthLink(
    env.X_OAUTH_REDIRECT_URI,
    { scope: SCOPES },
  );

  process.stdout.write(`\nOpen this URL in a browser logged in as the Strand account:\n\n${url}\n\n`);

  const port = Number(new URL(env.X_OAUTH_REDIRECT_URI).port || "4567");
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", env.X_OAUTH_REDIRECT_URI);
    const code = reqUrl.searchParams.get("code");
    const rState = reqUrl.searchParams.get("state");
    if (!code || rState !== state) {
      res.writeHead(400).end("missing code/state mismatch");
      return;
    }
    try {
      const { client: _c, accessToken, refreshToken, expiresIn } = await oauth.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri: env.X_OAUTH_REDIRECT_URI,
      });

      const me = await new TwitterApi(accessToken).v2.me();

      upsertEnv({
        X_USER_ID: me.data.id,
        X_USER_ACCESS_TOKEN: accessToken,
        ...(refreshToken ? { X_USER_REFRESH_TOKEN: refreshToken } : {}),
        X_USER_TOKEN_EXPIRES_AT: new Date(Date.now() + expiresIn * 1000).toISOString(),
      });

      res.writeHead(200).end(`ok — captured tokens for @${me.data.username}`);
      process.stdout.write(`\ncaptured tokens for @${me.data.username} (id=${me.data.id})\n`);
      process.stdout.write(`tokens written to .env\n`);
      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      res.writeHead(500).end(`error: ${String(err)}`);
      process.stdout.write(`\nerror: ${String(err)}\n`);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    process.stdout.write(`waiting for callback on ${env.X_OAUTH_REDIRECT_URI} ...\n`);
  });
}

function upsertEnv(updates: Record<string, string>): void {
  const path = ".env";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split("\n");
  const keys = new Set(Object.keys(updates));
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && keys.has(m[1] ?? "")) continue;
    out.push(line);
  }
  for (const [k, v] of Object.entries(updates)) out.push(`${k}=${v}`);
  writeFileSync(path, out.join("\n"));
  appendFileSync(path, "");
}

void main();
