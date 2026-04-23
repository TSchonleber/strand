import { constants, accessSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isExecutable } from "@/util/which";
import type { Command } from "commander";
import type { CliContext } from "../index";
import { printErr, printLine } from "../util/output";

/**
 * `strand doctor` — preflight checks. Exits 0 when the minimum viable
 * install works (node version + LLM credential resolvable), else 1.
 *
 * Non-blocking extras (docker, brainctl, optional credential backends) are
 * reported as warnings so a fresh install gets a clean bill of health with
 * just a provider API key set.
 */

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

export function registerDoctorCmd(program: Command, _ctx: CliContext): void {
  program
    .command("doctor")
    .description("preflight health check — node, LLM credentials, native deps, optional extras")
    .option("--json", "emit the report as JSON")
    .action(async (opts: { json?: boolean }) => {
      const checks: Check[] = [];

      // ── Node version ──
      const [majorStr] = process.versions.node.split(".");
      const major = Number.parseInt(majorStr ?? "0", 10);
      checks.push({
        name: "node",
        status: major >= 22 ? "ok" : "fail",
        detail: `v${process.versions.node}`,
        ...(major < 22 ? { hint: "Strand requires Node >= 22. Use `nvm install 22`." } : {}),
      });

      // ── better-sqlite3 native module loads ──
      try {
        const mod = await import("better-sqlite3");
        const Ctor = (mod.default ?? mod) as unknown as new (p: string) => { close(): void };
        const db = new Ctor(":memory:");
        db.close();
        checks.push({ name: "better-sqlite3", status: "ok", detail: "loaded ok" });
      } catch (err) {
        checks.push({
          name: "better-sqlite3",
          status: "fail",
          detail: err instanceof Error ? err.message : String(err),
          hint:
            "Native compile failed. On macOS: `xcode-select --install`. " +
            "On Linux: `apt install build-essential python3`. Then `pnpm rebuild better-sqlite3`.",
        });
      }

      // ── LLM provider + credential ──
      const provider = process.env["LLM_PROVIDER"] ?? "xai";
      const keyEnv: Record<string, string> = {
        xai: "XAI_API_KEY",
        openai: "OPENAI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        gemini: "GEMINI_API_KEY",
      };
      const expectedKey = keyEnv[provider];
      if (!expectedKey) {
        checks.push({
          name: `llm:${provider}`,
          status: "fail",
          detail: `unknown provider "${provider}"`,
          hint: "Set LLM_PROVIDER to one of: xai | openai | anthropic | gemini",
        });
      } else {
        const credPresent = await credentialResolves(expectedKey);
        checks.push({
          name: `llm:${provider}`,
          status: credPresent ? "ok" : "fail",
          detail: credPresent ? `${expectedKey} resolves` : `${expectedKey} not set`,
          ...(credPresent
            ? {}
            : {
                hint: `Run \`strand init\` for a guided setup, or \`strand keys set ${expectedKey}\` to store the key.`,
              }),
        });
      }

      // ── .strand dirs writable ──
      for (const dir of [join(homedir(), ".strand"), join(process.cwd(), ".strand")]) {
        const exists = existsSync(dir);
        const writable = exists ? canWrite(dir) : canWrite(homedir());
        checks.push({
          name: `dir:${dir.replace(homedir(), "~")}`,
          status: writable ? "ok" : "warn",
          detail: exists ? "exists · writable" : "will be created on first use",
        });
      }

      // ── Optional: brainctl ──
      const brainctlCmd = process.env["BRAINCTL_COMMAND"] ?? "brainctl";
      const brainctlOn = isExecutable(brainctlCmd);
      checks.push({
        name: "brainctl",
        status: brainctlOn ? "ok" : "warn",
        detail: brainctlOn
          ? `found at ${brainctlCmd}`
          : "not on PATH (brain_* tools will be skipped)",
        ...(brainctlOn
          ? {}
          : {
              hint: "Optional — only needed for long-term memory. See github.com/TSchonleber/brainctl.",
            }),
      });

      // ── Optional: docker ──
      const dockerOn = isExecutable("docker");
      checks.push({
        name: "docker",
        status: dockerOn ? "ok" : "warn",
        detail: dockerOn ? "found" : "not on PATH",
        ...(dockerOn
          ? {}
          : {
              hint: "Optional — only needed for DockerExecutor (computer-use sandbox).",
            }),
      });

      if (opts.json) {
        printLine(JSON.stringify({ checks }, null, 2));
      } else {
        render(checks);
      }

      const hasFail = checks.some((c) => c.status === "fail");
      process.exit(hasFail ? 1 : 0);
    });
}

function render(checks: Check[]): void {
  const icon = (s: Status): string => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗");
  const pad = (s: string, n: number): string => s.padEnd(n);
  const nameWidth = Math.max(...checks.map((c) => c.name.length), 12);
  for (const c of checks) {
    printLine(`${icon(c.status)}  ${pad(c.name, nameWidth)}  ${c.detail}`);
    if (c.hint) printLine(`   ↳ ${c.hint}`);
  }
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  printLine("");
  if (fail > 0) {
    printErr(
      `${fail} check${fail === 1 ? "" : "s"} failed, ${warn} warning${warn === 1 ? "" : "s"}`,
    );
  } else {
    printLine(`all required checks passed (${warn} warning${warn === 1 ? "" : "s"})`);
  }
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function credentialResolves(key: string): Promise<boolean> {
  // Try the full credential-store resolver so file / encrypted-file / keychain
  // backends are honored. Fall back to raw process.env on store-init errors so
  // `strand doctor` still reports something actionable.
  try {
    const { credentials } = await import("@/auth");
    const store = credentials();
    const v = await store.get(key);
    return typeof v === "string" && v.length > 0;
  } catch {
    const v = process.env[key];
    return typeof v === "string" && v.length > 0;
  }
}
