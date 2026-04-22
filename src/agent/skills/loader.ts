import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "@/util/log";
import { parse as parseYaml } from "yaml";
import type { ToolRegistry } from "../types";
import { skillToTool } from "./to-tool";
import type { Skill, SkillDocument, SkillOrigin, SkillSideEffects } from "./types";

/**
 * Skill file format: markdown with a leading YAML front-matter block.
 *
 *   ---
 *   name: my-skill
 *   description: ...
 *   parameters: { ... }       # optional, JSON Schema object
 *   allowedTools: [...]       # optional
 *   sideEffects: local|...    # optional
 *   requiresLive: false       # optional
 *   ---
 *   <markdown body>
 *
 * Body may contain `---` rulers freely — only the leading `^---\n…\n---\n`
 * block is interpreted as front-matter.
 */

export interface LoadSkillsOpts {
  /** Project skills dir. Default: `${cwd}/.strand/skills`. */
  projectDir?: string;
  /** User skills dir. Default: `${os.homedir()}/.strand/skills`. Pass `null` to disable. */
  userDir?: string | null;
  /**
   * If provided, each successfully loaded Skill is synthesized into a Tool
   * and registered here. Registration order: project first (wins), then user
   * for any names not already registered.
   */
  registry?: ToolRegistry;
  onWarn?(msg: string, detail: Record<string, unknown>): void;
}

export interface LoadSkillsResult {
  skills: Skill[];
  /** Names shadowed by project over user. */
  shadowed: string[];
  errors: Array<{ path: string; error: string }>;
}

const SKILL_FILE_RE = /\.skill\.md$/;
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME_RE = /^[a-z][a-z0-9_-]+$/;
const MAX_DESCRIPTION = 400;
const VALID_SIDE_EFFECTS: readonly SkillSideEffects[] = [
  "none",
  "local",
  "external",
  "destructive",
];

const DEFAULT_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
  required: [],
};

export async function loadSkills(opts: LoadSkillsOpts = {}): Promise<LoadSkillsResult> {
  const projectDir = opts.projectDir ?? join(process.cwd(), ".strand", "skills");
  const userDir =
    opts.userDir === null ? null : (opts.userDir ?? join(homedir(), ".strand", "skills"));
  const onWarn = opts.onWarn ?? ((msg, detail) => log.warn(detail, msg));

  const errors: Array<{ path: string; error: string }> = [];
  const byName = new Map<string, Skill>();
  const shadowed: string[] = [];

  // Project first — project wins on collision.
  const projectSkills = await loadDir(projectDir, "project", errors, onWarn);
  for (const s of projectSkills) {
    byName.set(s.name, s);
  }

  if (userDir) {
    const userSkills = await loadDir(userDir, "user", errors, onWarn);
    for (const s of userSkills) {
      if (byName.has(s.name)) {
        shadowed.push(s.name);
        onWarn("skills.shadowed", {
          svc: "agent",
          name: s.name,
          shadowedBy: byName.get(s.name)?.sourcePath,
          shadowedPath: s.sourcePath,
        });
        continue;
      }
      byName.set(s.name, s);
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (opts.registry) {
    for (const s of skills) {
      try {
        opts.registry.register(skillToTool(s, opts.registry, onWarn));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ path: s.sourcePath, error: msg });
        onWarn("skills.register_failed", {
          svc: "agent",
          name: s.name,
          error: msg,
        });
      }
    }
  }

  return { skills, shadowed, errors };
}

async function loadDir(
  dir: string,
  origin: SkillOrigin,
  errors: Array<{ path: string; error: string }>,
  onWarn: (msg: string, detail: Record<string, unknown>) => void,
): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    errors.push({ path: dir, error: e.message });
    return [];
  }

  const out: Skill[] = [];
  for (const entry of entries) {
    if (!SKILL_FILE_RE.test(entry)) continue;
    const sourcePath = resolve(dir, entry);
    try {
      const raw = await readFile(sourcePath, "utf8");
      const skill = parseSkill(raw, origin, sourcePath);
      if (skill instanceof Error) {
        errors.push({ path: sourcePath, error: skill.message });
        onWarn("skills.parse_failed", {
          svc: "agent",
          path: sourcePath,
          error: skill.message,
        });
        continue;
      }
      out.push(skill);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ path: sourcePath, error: msg });
      onWarn("skills.read_failed", { svc: "agent", path: sourcePath, error: msg });
    }
  }
  return out;
}

/**
 * Parse one skill file. Returns Error on any validation failure (caller
 * records it rather than throwing — load continues).
 */
export function parseSkill(raw: string, origin: SkillOrigin, sourcePath: string): Skill | Error {
  const m = FRONT_MATTER_RE.exec(raw);
  if (!m) return new Error("missing or malformed YAML front-matter");

  const frontRaw = m[1] ?? "";
  const body = (m[2] ?? "").trim();

  let front: unknown;
  try {
    front = parseYaml(frontRaw);
  } catch (err) {
    return new Error(`YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) {
    return new Error("front-matter must be a YAML object");
  }
  const fm = front as Record<string, unknown>;

  const name = fm["name"];
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return new Error(`invalid skill name: ${JSON.stringify(name)} (must match ${NAME_RE})`);
  }

  const description = fm["description"];
  if (typeof description !== "string" || description.length === 0) {
    return new Error("description is required");
  }
  if (description.length > MAX_DESCRIPTION) {
    return new Error(`description exceeds ${MAX_DESCRIPTION} chars`);
  }

  const parameters = fm["parameters"];
  let params: Record<string, unknown> = DEFAULT_PARAMETERS;
  if (parameters !== undefined && parameters !== null) {
    if (
      typeof parameters !== "object" ||
      Array.isArray(parameters) ||
      (parameters as Record<string, unknown>)["type"] !== "object"
    ) {
      return new Error("parameters must be a JSON Schema object with type: object");
    }
    const jsonStr = JSON.stringify(parameters);
    if (jsonStr.includes('"$ref"')) {
      return new Error("parameters may not use $ref (keep schemas inline)");
    }
    params = parameters as Record<string, unknown>;
  }

  const allowedToolsRaw = fm["allowedTools"];
  let allowedTools: readonly string[] | undefined;
  if (allowedToolsRaw !== undefined && allowedToolsRaw !== null) {
    if (!Array.isArray(allowedToolsRaw) || !allowedToolsRaw.every((v) => typeof v === "string")) {
      return new Error("allowedTools must be an array of strings");
    }
    allowedTools = allowedToolsRaw as string[];
  }

  const sideEffectsRaw = fm["sideEffects"];
  let sideEffects: SkillSideEffects = "local";
  if (sideEffectsRaw !== undefined && sideEffectsRaw !== null) {
    if (
      typeof sideEffectsRaw !== "string" ||
      !VALID_SIDE_EFFECTS.includes(sideEffectsRaw as SkillSideEffects)
    ) {
      return new Error(`sideEffects must be one of: ${VALID_SIDE_EFFECTS.join(", ")}`);
    }
    sideEffects = sideEffectsRaw as SkillSideEffects;
  }

  const requiresLiveRaw = fm["requiresLive"];
  let requiresLive = false;
  if (requiresLiveRaw !== undefined && requiresLiveRaw !== null) {
    if (typeof requiresLiveRaw !== "boolean") {
      return new Error("requiresLive must be a boolean");
    }
    requiresLive = requiresLiveRaw;
  }

  if (body.length === 0) {
    return new Error("skill body is empty");
  }

  const doc: SkillDocument = {
    name,
    description,
    parameters: params,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    sideEffects,
    requiresLive,
    body,
  };
  return { ...doc, origin, sourcePath };
}

/** Re-export for consumers that hand-render front-matter. */
export { FRONT_MATTER_RE };
