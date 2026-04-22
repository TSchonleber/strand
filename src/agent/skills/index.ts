/**
 * Skills — procedural memory stored as files, loaded into the tool registry.
 *
 * A Skill is a named markdown+YAML file in `./.strand/skills/` (project) or
 * `~/.strand/skills/` (user). On registry construction, skills are parsed
 * and each becomes a synthesized `Tool` whose `execute()` spawns a nested
 * `runPlan` — same recursion semantics as `spawn()`, bounded by `maxDepth`.
 *
 * Entry points:
 *   - `loadSkills(opts)` — discover + parse + (optionally) register
 *   - `skillToTool(skill, registry)` — lower-level synthesis
 *   - `SkillWriter` — write/remove files (CLI + future auto-creation hook)
 */

export { loadSkills, parseSkill } from "./loader";
export type { LoadSkillsOpts, LoadSkillsResult } from "./loader";
export { buildGoal, skillToTool } from "./to-tool";
export type { Skill, SkillDocument, SkillOrigin, SkillSideEffects } from "./types";
export { SkillWriter, renderSkillFile } from "./writer";

// Autonomous skill creation:
export { autoCreateSkill, setDefaultSkillProposalStore } from "./auto-create";
export type {
  AutoCreateMode,
  AutoCreateResult,
  AutoCreateSkillOpts,
  SkillProposal,
  SkillProposalStore,
} from "./auto-create";
export { SqliteSkillProposalStore, makeSqliteSkillProposalStore } from "./proposal-store";
