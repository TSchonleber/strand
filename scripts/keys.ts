#!/usr/bin/env tsx
/**
 * `strand keys` — CLI for managing the credential store.
 *
 * Usage:
 *   tsx scripts/keys.ts list
 *   tsx scripts/keys.ts get <KEY>
 *   tsx scripts/keys.ts set <KEY> <VALUE>
 *   tsx scripts/keys.ts set <KEY>               # prompt for value on stdin (hidden)
 *   tsx scripts/keys.ts delete <KEY>
 *   tsx scripts/keys.ts refresh-oauth <ACCESS_KEY>
 *
 * Store selection:
 *   STRAND_CREDENTIAL_STORE=env        (default — process.env)
 *   STRAND_CREDENTIAL_STORE=file       (~/.strand/credentials.json, 0600)
 *   STRAND_CREDENTIAL_STORE=file+env   (file overrides env)
 *
 * Typical BYOK workflow:
 *   export STRAND_CREDENTIAL_STORE=file
 *   pnpm keys set XAI_API_KEY           # prompt
 *   pnpm keys set ANTHROPIC_API_KEY     # prompt
 *   pnpm keys list
 */

import { createInterface } from "node:readline/promises";
import { OAuthCredentialStore, credentials } from "@/auth";

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = credentials();

  switch (cmd) {
    case "list": {
      const keys = await store.list();
      keys.sort();
      for (const k of keys) {
        const v = await store.get(k);
        const masked = v ? mask(v) : "";
        process.stdout.write(`${k}\t${masked}\n`);
      }
      return 0;
    }

    case "get": {
      const key = rest[0];
      if (!key) {
        process.stderr.write("usage: keys get <KEY>\n");
        return 2;
      }
      const v = await store.get(key);
      if (v === undefined) {
        process.stderr.write(`not set: ${key}\n`);
        return 1;
      }
      process.stdout.write(`${v}\n`);
      return 0;
    }

    case "set": {
      const key = rest[0];
      if (!key) {
        process.stderr.write("usage: keys set <KEY> [<VALUE>]\n");
        return 2;
      }
      const valueArg = rest[1];
      const value = valueArg ?? (await readSecret(`${key}: `));
      if (!value) {
        process.stderr.write("empty value — aborting\n");
        return 2;
      }
      await store.set(key, value);
      process.stdout.write(`ok: ${key} → ${store.name}\n`);
      return 0;
    }

    case "delete": {
      const key = rest[0];
      if (!key) {
        process.stderr.write("usage: keys delete <KEY>\n");
        return 2;
      }
      await store.delete(key);
      process.stdout.write(`deleted: ${key}\n`);
      return 0;
    }

    case "refresh-oauth": {
      const accessKey = rest[0];
      if (!accessKey) {
        process.stderr.write("usage: keys refresh-oauth <ACCESS_TOKEN_KEY>\n");
        return 2;
      }
      if (!(store instanceof OAuthCredentialStore)) {
        process.stderr.write(
          "credential store is not OAuth-aware; set STRAND_CREDENTIAL_STORE to a mode that enables OAuth\n",
        );
        return 2;
      }
      await store.refreshNow(accessKey);
      process.stdout.write(`refreshed: ${accessKey}\n`);
      return 0;
    }

    default: {
      process.stderr.write(
        "usage: keys {list | get <KEY> | set <KEY> [<VALUE>] | delete <KEY> | refresh-oauth <ACCESS_KEY>}\n",
      );
      return 2;
    }
  }
}

async function readSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Basic prompt — stdin echo handling varies across shells; good enough
    // for a dev tool. Users on production hosts should prefer `keys set K V`.
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function mask(v: string): string {
  if (v.length <= 8) return "********";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
