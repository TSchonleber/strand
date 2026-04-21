/**
 * Filesystem tools: fs_read, fs_write, fs_search.
 *
 * Workdir scoping: tools consult `ctx.metadata.workdir` at execute() time. The
 * `registerDefaults({ workdir })` helper bakes a default into the tool closure;
 * if the caller also sets `ctx.metadata.workdir`, that takes precedence.
 */

import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { AgentContext, Tool } from "../types";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const SEARCH_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "data"]);
const SEARCH_MAX_FILE_BYTES = 1 * 1024 * 1024;

function resolveWorkdir(ctx: AgentContext, fallback?: string): string | undefined {
  const meta = ctx.metadata;
  if (meta && typeof meta["workdir"] === "string") return meta["workdir"];
  return fallback;
}

function ensureInsideWorkdir(targetAbs: string, workdir: string | undefined): void {
  if (!workdir) return;
  const wdAbs = resolve(workdir);
  const rel = relative(wdAbs, targetAbs);
  if (rel.startsWith("..") || resolve(wdAbs, rel) !== targetAbs) {
    throw new Error(`fs: path "${targetAbs}" is outside workdir "${wdAbs}"`);
  }
}

export interface FsReadArgs {
  path: string;
  maxBytes?: number;
}
export interface FsReadResult {
  path: string;
  content: string;
  truncated: boolean;
}

export function makeFsRead(defaults: { workdir?: string } = {}): Tool<FsReadArgs, FsReadResult> {
  return {
    name: "fs_read",
    description: "Read a UTF-8 text file. Caps at maxBytes and reports truncation.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to read (absolute or relative to cwd)." },
        maxBytes: { type: "integer", minimum: 1, description: "Byte cap; default 262144." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args, ctx) {
      const abs = resolve(args.path);
      ensureInsideWorkdir(abs, resolveWorkdir(ctx, defaults.workdir));
      const cap = args.maxBytes ?? DEFAULT_MAX_BYTES;
      const buf = await readFile(abs);
      const truncated = buf.byteLength > cap;
      const slice = truncated ? buf.subarray(0, cap) : buf;
      return {
        path: abs,
        content: slice.toString("utf8"),
        truncated,
      };
    },
  };
}

export interface FsWriteArgs {
  path: string;
  content: string;
  mode?: number;
}
export interface FsWriteResult {
  path: string;
  bytes: number;
}

export function makeFsWrite(defaults: { workdir?: string } = {}): Tool<FsWriteArgs, FsWriteResult> {
  return {
    name: "fs_write",
    description: "Write a UTF-8 text file. Creates parent dirs with 0700.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: {
          type: "integer",
          description: "POSIX file mode as a decimal integer (e.g. 420 === 0o644).",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    sideEffects: "local",
    requiresLive: false,
    async execute(args, ctx) {
      const abs = resolve(args.path);
      ensureInsideWorkdir(abs, resolveWorkdir(ctx, defaults.workdir));
      await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
      const mode = args.mode ?? 0o644;
      await writeFile(abs, args.content, { encoding: "utf8", mode });
      return { path: abs, bytes: Buffer.byteLength(args.content, "utf8") };
    },
  };
}

export interface FsSearchArgs {
  query: string;
  path?: string;
  maxResults?: number;
  regex?: boolean;
  caseSensitive?: boolean;
}
export interface FsSearchMatch {
  file: string;
  line: number;
  preview: string;
}
export interface FsSearchResult {
  matches: FsSearchMatch[];
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    const name = String(e.name);
    if (e.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(name)) continue;
      yield* walk(resolve(dir, name));
    } else if (e.isFile()) {
      yield resolve(dir, name);
    }
  }
}

export function makeFsSearch(
  defaults: { workdir?: string } = {},
): Tool<FsSearchArgs, FsSearchResult> {
  return {
    name: "fs_search",
    description:
      "Recursive grep-like search. Case-insensitive by default. Set regex=true for regex mode. Caps at 100 matches.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string", description: "Root dir. Defaults to workdir or cwd." },
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
        regex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    sideEffects: "none",
    async execute(args, ctx) {
      const wd = resolveWorkdir(ctx, defaults.workdir);
      const root = resolve(args.path ?? wd ?? process.cwd());
      ensureInsideWorkdir(root, wd);
      const cap = Math.min(
        args.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS,
        DEFAULT_MAX_SEARCH_RESULTS,
      );
      const flags = args.caseSensitive === true ? "" : "i";
      const pattern =
        args.regex === true
          ? new RegExp(args.query, flags)
          : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

      const matches: FsSearchMatch[] = [];
      for await (const file of walk(root)) {
        if (matches.length >= cap) break;
        let s: Awaited<ReturnType<typeof stat>>;
        try {
          s = await stat(file);
        } catch {
          continue;
        }
        if (s.size > SEARCH_MAX_FILE_BYTES) continue;
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= cap) break;
          const line = lines[i] ?? "";
          if (pattern.test(line)) {
            matches.push({
              file,
              line: i + 1,
              preview: line.length > 200 ? `${line.slice(0, 200)}…` : line,
            });
          }
        }
      }
      return { matches };
    },
  };
}
