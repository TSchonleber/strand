import { policies } from "@/config";
import type { Candidate } from "@/types/actions";
import type Database from "better-sqlite3";

/**
 * Duplicate-text guard. We store recent post/reply text in SQLite and use
 * a character-trigram Jaccard approximation for "similar enough" — cheap,
 * no embedding call required. When we wire a real embedding index,
 * swap the `similarity` function.
 */

export interface DuplicatesResult {
  ok: boolean;
  reasons: string[];
  ruleIds: string[];
}

function trigrams(s: string): Set<string> {
  const t = new Set<string>();
  const clean = s.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < clean.length - 2; i++) t.add(clean.slice(i, i + 3));
  return t;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function duplicatesRule(db: Database.Database, c: Candidate<"proposed">): DuplicatesResult {
  const a = c.action;
  if (!("text" in a)) return { ok: true, reasons: [], ruleIds: [] };

  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = db
    .prepare("SELECT text FROM post_embeddings WHERE created_at >= ?")
    .all(since) as Array<{ text: string }>;

  const candidate = trigrams(a.text);
  const threshold = policies.thresholds.max_reply_cosine_7d;
  for (const r of rows) {
    const sim = jaccard(candidate, trigrams(r.text));
    if (sim > threshold) {
      return {
        ok: false,
        reasons: [`near_duplicate:${sim.toFixed(2)}>${threshold}`],
        ruleIds: ["duplicates.7d"],
      };
    }
  }
  return { ok: true, reasons: [], ruleIds: [] };
}

export function recordPostText(db: Database.Database, tweetId: string, text: string): void {
  db.prepare("INSERT OR REPLACE INTO post_embeddings (tweet_id, text) VALUES (?, ?)").run(
    tweetId,
    text,
  );
}
