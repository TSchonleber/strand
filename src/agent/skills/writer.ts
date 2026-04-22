import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { SkillDocument } from "./types";

/**
 * Programmatic skill file creation.
 *
 * Used by:
 *   - `strand skills add` CLI
 *   - Future auto-creation hook (Phase 2 — the model proposes skills at the
 *     end of successful runs). The stub is `SkillWriter.write(doc)`; no
 *     auto-invoke path is wired today.
 *
 * Atomic write: YAML-front-matter + markdown body → tmpfile → rename().
 */
export class SkillWriter {
  constructor(private readonly dir: string) {}

  async write(doc: SkillDocument): Promise<{ path: string }> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${doc.name}.skill.md`);
    const content = renderSkillFile(doc);

    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, content, "utf8");
    try {
      await rename(tmp, path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return { path };
  }

  async remove(name: string): Promise<boolean> {
    const path = join(this.dir, `${name}.skill.md`);
    try {
      await unlink(path);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return false;
      throw err;
    }
  }

  get directory(): string {
    return this.dir;
  }
}

/** Render a SkillDocument to its on-disk representation. */
export function renderSkillFile(doc: SkillDocument): string {
  const front: Record<string, unknown> = {
    name: doc.name,
    description: doc.description,
    parameters: doc.parameters,
  };
  if (doc.allowedTools !== undefined) front["allowedTools"] = doc.allowedTools;
  if (doc.sideEffects !== undefined) front["sideEffects"] = doc.sideEffects;
  if (doc.requiresLive !== undefined) front["requiresLive"] = doc.requiresLive;

  const yaml = stringifyYaml(front, { lineWidth: 0 }).trimEnd();
  const body = doc.body.trimEnd();
  return `---\n${yaml}\n---\n\n${body}\n`;
}

/** Ensure a directory exists. Convenience for callers. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dirname(join(dir, "x")), { recursive: true });
}
