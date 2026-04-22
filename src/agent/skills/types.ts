/**
 * Skill types — procedural memory stored as markdown files with YAML
 * front-matter, loaded into the ToolRegistry as synthesized Tools.
 *
 * A Skill's body is free-form markdown that becomes the GOAL passed to a
 * nested `runPlan` when the skill is invoked as a tool. Arguments are
 * interpolated into the body via `{{paramName}}` substitution.
 */

export type SkillOrigin = "project" | "user";

export type SkillSideEffects = "none" | "local" | "external" | "destructive";

export interface SkillDocument {
  /** Tool-name safe identifier: /^[a-z][a-z0-9_-]+$/. */
  name: string;
  /** One-sentence description (≤ 400 chars). Fed to the LLM. */
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Optional allowlist of tool names the nested runPlan may call. */
  allowedTools?: readonly string[];
  sideEffects?: SkillSideEffects;
  requiresLive?: boolean;
  /** Markdown body — becomes the nested runPlan goal with args interpolated. */
  body: string;
}

export interface Skill extends SkillDocument {
  origin: SkillOrigin;
  /** Absolute path the skill was loaded from. */
  sourcePath: string;
}
