import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { persona } from "@/config";
import { log } from "@/util/log";
import YAML from "yaml";
import { z } from "zod";

/**
 * Cheap local pre-filter to avoid paying xAI's $0.05 usage-guideline
 * violation fee on predictably-bad prompts. This is not a safety layer —
 * it's a cost guard. Grok's own filters still apply on top.
 *
 * Layers (rejections are short-circuit, cheapest first):
 *   1. Regex banlist — always-bad strings.
 *   2. Banned-topic substring — persona.banned_topics.
 *   3. Embedding cosine similarity against config/banned_exemplars.yaml
 *      (bge-small-en-v1.5 via @xenova/transformers). Reject if any
 *      exemplar cos >= SIMILARITY_THRESHOLD.
 *
 * The embedder is lazy-init via a module-level promise. If it fails to load,
 * prefilterText refuses everything — we never silently degrade to regex-only.
 */

const REGEX_PATTERNS: RegExp[] = [
  // Keep conservative; false positives waste candidate slots.
  /\b(kill yourself|kys)\b/i,
];

const SIMILARITY_THRESHOLD = 0.8;
const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

const BannedExemplarsSchema = z.object({
  exemplars: z
    .array(
      z.object({
        text: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .min(1),
});

type BannedExemplar = { text: string; reason: string };

function loadExemplars(): BannedExemplar[] {
  const path = resolve(process.cwd(), "config/banned_exemplars.yaml");
  const raw = readFileSync(path, "utf8");
  const parsed = BannedExemplarsSchema.parse(YAML.parse(raw));
  return parsed.exemplars;
}

const exemplars = loadExemplars();

// ─── Embedder (lazy, injectable for tests) ────────────────────

export type EmbeddingFn = (text: string) => Promise<Float32Array>;

let embedderOverride: EmbeddingFn | null = null;
let embedderPromise: Promise<EmbeddingFn> | null = null;
let exemplarEmbeddingsPromise: Promise<Float32Array[]> | null = null;

/** Test-only hook. Pass null to reset back to the real loader. */
export function _setEmbedderForTests(fn: EmbeddingFn | null): void {
  embedderOverride = fn;
  embedderPromise = null;
  exemplarEmbeddingsPromise = null;
}

async function defaultEmbedderFactory(): Promise<EmbeddingFn> {
  // Dynamic import so the heavy ONNX runtime only loads when actually needed.
  const { pipeline, env: xenvEnv } = await import("@xenova/transformers");
  // Tests + CI: no live CDN fallback if a local cache was seeded. In dev/prod
  // the default allowRemoteModels=true lets the Hub fetch on first run.
  xenvEnv.allowLocalModels = true;
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    quantized: true,
  });
  return async (text: string): Promise<Float32Array> => {
    const out = await extractor(text, { pooling: "mean", normalize: true });
    // @xenova/transformers returns a Tensor whose .data is a Float32Array.
    // biome-ignore lint/suspicious/noExplicitAny: Tensor typing lags runtime shape.
    const data = (out as any).data as Float32Array;
    return data;
  };
}

async function getEmbedder(): Promise<EmbeddingFn> {
  if (embedderOverride) return embedderOverride;
  if (!embedderPromise) {
    embedderPromise = defaultEmbedderFactory().catch((err) => {
      log.error(
        { svc: "prefilter", err: err instanceof Error ? err.message : String(err) },
        "prefilter.embedder_load_failed",
      );
      // Re-throw so every subsequent prefilterText call also rejects. We
      // deliberately do NOT cache a fallback — silent degradation to
      // regex-only is worse than hard-reject here.
      throw err;
    });
  }
  return embedderPromise;
}

async function getExemplarEmbeddings(): Promise<Float32Array[]> {
  if (!exemplarEmbeddingsPromise) {
    exemplarEmbeddingsPromise = (async () => {
      const embed = await getEmbedder();
      return Promise.all(exemplars.map((e) => embed(e.text)));
    })();
  }
  return exemplarEmbeddingsPromise;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Public API ───────────────────────────────────────────────

export interface PrefilterResult {
  ok: boolean;
  reasons: string[];
  /** Max cosine similarity observed against any banned exemplar (when computed). */
  similarity?: number;
  /** Name of the exemplar class that triggered an embedding rejection. */
  matchedExemplar?: string;
}

/**
 * Cheap sync filter: regex + persona banned-topic substring only.
 *
 * Used by the policy gate (runs on EVERY candidate; the gate doesn't pay
 * the xAI $0.05 compose tax, so the embedding layer is dead weight there).
 *
 * For composer calls use `prefilterComposerText` (async, adds
 * embedding-similarity check against banned exemplars).
 */
export function prefilterText(text: string): PrefilterResult {
  const reasons: string[] = [];

  for (const p of REGEX_PATTERNS) {
    if (p.test(text)) reasons.push(`matches_pattern:${p.source}`);
  }

  const lower = text.toLowerCase();
  for (const topic of persona.banned_topics) {
    if (lower.includes(topic.toLowerCase())) {
      reasons.push(`banned_topic:${topic}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Full async filter for composer calls: regex + banned-topic + embedding
 * similarity against the banned-exemplar corpus. Use this on every
 * composition prompt before calling xAI — local rejects score ~free;
 * xAI pre-generation rejects cost $0.05/request.
 *
 * Kill switch: if the embedder fails to load, this refuses everything
 * rather than silently degrading to regex-only. The embedding layer is the
 * reason this function exists; regex-only defeats the cost-guard purpose.
 */
export async function prefilterComposerText(text: string): Promise<PrefilterResult> {
  const sync = prefilterText(text);
  if (!sync.ok) return sync;

  let embed: EmbeddingFn;
  let exemplarVectors: Float32Array[];
  try {
    embed = await getEmbedder();
    exemplarVectors = await getExemplarEmbeddings();
  } catch (err) {
    // Kill switch: embedder failed to load. Refuse everything rather than
    // silently falling back to regex-only. Cost guard relies on this layer.
    return {
      ok: false,
      reasons: [`embedder_unavailable:${err instanceof Error ? err.message : String(err)}`],
    };
  }

  let inputVec: Float32Array;
  try {
    inputVec = await embed(text);
  } catch (err) {
    return {
      ok: false,
      reasons: [`embedding_failed:${err instanceof Error ? err.message : String(err)}`],
    };
  }

  let maxSim = 0;
  let matchedIdx = -1;
  for (let i = 0; i < exemplarVectors.length; i++) {
    const v = exemplarVectors[i];
    if (!v) continue;
    const sim = cosineSimilarity(inputVec, v);
    if (sim > maxSim) {
      maxSim = sim;
      matchedIdx = i;
    }
  }

  if (maxSim >= SIMILARITY_THRESHOLD && matchedIdx >= 0) {
    const matched = exemplars[matchedIdx];
    return {
      ok: false,
      reasons: [`banned_exemplar:${matched?.reason ?? "unknown"}`],
      similarity: maxSim,
      ...(matched ? { matchedExemplar: matched.reason } : {}),
    };
  }

  return { ok: true, reasons: [], similarity: maxSim };
}

/** Test-only: clear all caches (embedder + exemplar vectors). */
export function _resetPrefilterCaches(): void {
  embedderPromise = null;
  exemplarEmbeddingsPromise = null;
  embedderOverride = null;
}
