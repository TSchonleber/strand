/**
 * Walk-up repository context-file reader.
 *
 * Reads well-known context files (CLAUDE.md, AGENTS.md, .cursorrules,
 * .strand.md) from the agent's working directory and ancestor directories,
 * scans each one for prompt-injection attempts, and concatenates the safe
 * ones for inclusion in the plan-runner's USER message stream.
 *
 * IMPORTANT — cache hygiene:
 *   Repository context is handed to the LLM as a USER message, NOT injected
 *   into the system prompt. The static prefix (system prompt + cache key)
 *   must stay byte-identical across steps of a plan; that's what lets the
 *   provider serve cache hits. Burning per-call context into the system
 *   prompt is a Hermes anti-pattern — see Pass Q. We stay out of it.
 *
 * Safety:
 *   - The scanner runs on every file read. `high`-severity hits block the
 *     file (added to `blocked`, NOT to `content`). `warn` lets the file
 *     through with sanitized text and the findings attached for logging.
 *   - Total output is capped at `maxTotalBytes` (64 KB default) with an
 *     explicit truncation marker. Truncation is deterministic (head-only).
 *   - No network. No symlink traversal outside the walk path — we use
 *     `lstat` + refuse symlinked matches.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Finding, type ScanResult, scanForInjection } from "./injection-scanner";

export interface ContextFileResult {
  /** Concatenated file bodies, each prefixed with `## <absolute path>`. */
  content: string;
  /** Absolute paths that contributed to `content`. */
  sources: string[];
  /** Scanner findings across all files (file is still loaded on warn). */
  findings: Finding[];
  /** Absolute paths that were rejected by the scanner (not in `content`). */
  blocked: string[];
}

export interface LoadContextFilesOptions {
  /** Directory to start from. Default: process.cwd(). */
  cwd?: string;
  /** Walk-up depth — how many parent directories to visit. Default 4. */
  maxDepth?: number;
  /** File names to look for in each directory. */
  filenames?: readonly string[];
  /** Cap on total concatenated body size. Default 64 KB. */
  maxTotalBytes?: number;
  /** Block files that have any `high` severity finding. Default true. */
  blockOnHighSeverity?: boolean;
}

const DEFAULT_FILENAMES: readonly string[] = Object.freeze([
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".strand.md",
]);

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024;
const TRUNCATION_MARKER = (limit: number): string =>
  `\n\n[… truncated, over ${Math.round(limit / 1024)} KB …]\n`;

/**
 * Walk up from `cwd`, reading any of `filenames` we find at each level.
 * Stops at HOME or after `maxDepth` levels.
 */
async function collectCandidatePaths(
  cwd: string,
  maxDepth: number,
  filenames: readonly string[],
): Promise<string[]> {
  const paths: string[] = [];
  const home = homedir();
  let dir = resolve(cwd);
  for (let depth = 0; depth <= maxDepth; depth++) {
    for (const name of filenames) {
      paths.push(join(dir, name));
    }
    // Stop when we hit the home directory (don't read ~/CLAUDE.md into
    // per-project context; global rules are the user's problem).
    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return paths;
}

/**
 * Read a file, but only if the direntry itself is a real file (not a
 * symlink). This stops a malicious CLAUDE.md from pointing at /etc/passwd.
 */
async function readRegularFile(path: string): Promise<string | null> {
  try {
    const st = await fs.lstat(path);
    if (!st.isFile()) return null;
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function loadContextFiles(
  opts: LoadContextFilesOptions = {},
): Promise<ContextFileResult> {
  const cwd = opts.cwd ?? process.cwd();
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const filenames = opts.filenames ?? DEFAULT_FILENAMES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const blockOnHigh = opts.blockOnHighSeverity ?? true;

  const candidates = await collectCandidatePaths(cwd, maxDepth, filenames);

  const sources: string[] = [];
  const blocked: string[] = [];
  const allFindings: Finding[] = [];
  const pieces: string[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const path of candidates) {
    const body = await readRegularFile(path);
    if (body === null) continue;

    const scan: ScanResult = scanForInjection(body);
    // Even `warn` findings bubble up for observability.
    if (scan.findings.length > 0) allFindings.push(...scan.findings);

    const hasHigh = !scan.safe; // scanForInjection flips safe=false only on high
    if (blockOnHigh && hasHigh) {
      blocked.push(path);
      continue;
    }

    // Use sanitized text (invisibles stripped) regardless of severity.
    const header = `## ${path}\n\n`;
    const bodyPart = `${scan.sanitized}\n\n`;
    const chunk = header + bodyPart;

    if (usedBytes + chunk.length > maxTotalBytes) {
      // Fit what we can of the header+marker; stop walking afterwards.
      const remaining = maxTotalBytes - usedBytes;
      if (remaining > header.length + 16) {
        pieces.push(header);
        pieces.push(bodyPart.slice(0, remaining - header.length));
        usedBytes += remaining;
        sources.push(path);
      }
      truncated = true;
      break;
    }

    pieces.push(chunk);
    usedBytes += chunk.length;
    sources.push(path);
  }

  let content = pieces.join("");
  if (truncated) content += TRUNCATION_MARKER(maxTotalBytes);

  return { content, sources, findings: allFindings, blocked };
}

/** Exposed for tests — the canonical default filename list. */
export const CONTEXT_FILENAMES = DEFAULT_FILENAMES;

/** Exposed for log formatting. */
export function contextFileLabel(path: string): string {
  return basename(path);
}
