import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LoadedPrompt {
  name: string;
  content: string;
  hash: string;
}

const cache = new Map<string, LoadedPrompt>();

export function loadPrompt(name: string): LoadedPrompt {
  const cached = cache.get(name);
  if (cached) return cached;
  const path = resolve(process.cwd(), "prompts", `${name}.md`);
  const content = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const loaded = { name, content, hash };
  cache.set(name, loaded);
  return loaded;
}

export function clearPromptCache(): void {
  cache.clear();
}
