import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { CliContext } from "../index";
import { mask, printLine } from "../util/output";

/**
 * `strand keys` — credential store CRUD.
 *
 * Subcommands: list, get, set, delete, refresh-oauth.
 * Absorbed from `scripts/keys.ts`; store is the default `credentials()` chain.
 */
export function registerKeysCmd(program: Command, _ctx: CliContext): void {
  const keys = program.command("keys").description("manage credential store entries");

  keys
    .command("list")
    .description("list all keys (values masked)")
    .action(async () => {
      const { credentials } = await import("@/auth");
      const store = credentials();
      const names = (await store.list()).sort();
      for (const k of names) {
        const v = await store.get(k);
        process.stdout.write(`${k}\t${v ? mask(v) : ""}\n`);
      }
    });

  keys
    .command("get")
    .description("print a key's raw value (sensitive!)")
    .argument("<KEY>")
    .action(async (key: string) => {
      const { credentials } = await import("@/auth");
      const v = await credentials().get(key);
      if (v === undefined) {
        process.stderr.write(`not set: ${key}\n`);
        process.exit(1);
      }
      process.stdout.write(`${v}\n`);
    });

  keys
    .command("set")
    .description("set a key (prompts for VALUE if omitted)")
    .argument("<KEY>")
    .argument("[VALUE]")
    .action(async (key: string, value: string | undefined) => {
      const { credentials } = await import("@/auth");
      const store = credentials();
      const v = value ?? (await readLine(`${key}: `));
      if (!v) {
        process.stderr.write("empty value — aborting\n");
        process.exit(2);
      }
      await store.set(key, v);
      printLine(`ok: ${key} → ${store.name}`);
    });

  keys
    .command("delete")
    .description("delete a key from the credential store")
    .argument("<KEY>")
    .action(async (key: string) => {
      const { credentials } = await import("@/auth");
      await credentials().delete(key);
      printLine(`deleted: ${key}`);
    });

  keys
    .command("refresh-oauth")
    .description("force-refresh the OAuth token associated with <ACCESS_KEY>")
    .argument("<ACCESS_KEY>")
    .action(async (accessKey: string) => {
      const { credentials, OAuthCredentialStore } = await import("@/auth");
      const store = credentials();
      if (!(store instanceof OAuthCredentialStore)) {
        process.stderr.write(
          "credential store is not OAuth-aware; set STRAND_CREDENTIAL_STORE to a mode that enables OAuth\n",
        );
        process.exit(2);
      }
      await store.refreshNow(accessKey);
      printLine(`refreshed: ${accessKey}`);
    });
}

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}
