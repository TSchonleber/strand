import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { CliContext } from "../index";
import { printErr, printLine, printTable, truncate } from "../util/output";

/**
 * `strand skills` — manage procedural skills (markdown files with YAML
 * front-matter loaded into the tool registry).
 *
 *   skills list              — both dirs, annotated with origin
 *   skills show <name>       — print raw file + resolved path
 *   skills add <name>        — interactive (readline) write to ./.strand/skills
 *   skills remove <name>     — delete (defaults to project, --user for user)
 *   skills validate          — parse all, report errors
 */
export function registerSkillsCmd(program: Command, _ctx: CliContext): void {
  const skillsCmd = program.command("skills").description("manage procedural skills");

  // Env overrides exist so tests (and integrators running outside the project
  // root) can point the loader at a different dir. Normal use hits the
  // defaults: cwd/.strand/skills and ~/.strand/skills.
  const projectDir = (): string =>
    process.env["STRAND_SKILLS_PROJECT_DIR"] ?? join(process.cwd(), ".strand", "skills");
  const userDir = (): string =>
    process.env["STRAND_SKILLS_USER_DIR"] ?? join(homedir(), ".strand", "skills");

  skillsCmd
    .command("list")
    .description("list project + user skills")
    .action(async () => {
      const { loadSkills } = await import("@/agent");
      const { skills } = await loadSkills({ projectDir: projectDir(), userDir: userDir() });
      if (skills.length === 0) {
        printLine("no skills");
        return;
      }
      printTable(skills, [
        { header: "name", value: (s) => s.name, maxWidth: 28 },
        { header: "origin", value: (s) => s.origin, maxWidth: 8 },
        { header: "sideEffects", value: (s) => s.sideEffects ?? "local", maxWidth: 12 },
        { header: "description", value: (s) => truncate(s.description, 80), maxWidth: 80 },
      ]);
    });

  skillsCmd
    .command("show")
    .description("print a skill's file contents + resolved path")
    .argument("<name>")
    .action(async (name: string) => {
      const { loadSkills } = await import("@/agent");
      const { skills } = await loadSkills({ projectDir: projectDir(), userDir: userDir() });
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        printErr(`not found: ${name}`);
        process.exit(1);
      }
      printLine(`path: ${skill.sourcePath}`);
      printLine(`origin: ${skill.origin}`);
      printLine("---");
      const raw = await readFile(skill.sourcePath, "utf8");
      process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
    });

  skillsCmd
    .command("add")
    .description("interactive: write a new skill to ./.strand/skills/")
    .argument("<name>")
    .option("--dir <path>", "target directory (default ./.strand/skills)")
    .action(async (name: string, opts: { dir?: string }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const description = (await rl.question("description: ")).trim();
        if (!description) {
          printErr("description is required");
          process.exit(1);
        }
        const allowedRaw = (
          await rl.question("allowedTools (comma-separated, blank for all): ")
        ).trim();
        const sideEffects =
          (await rl.question("sideEffects [none|local|external|destructive] (local): ")).trim() ||
          "local";
        const requiresLiveRaw = (await rl.question("requiresLive [y/N]: ")).trim().toLowerCase();
        const body = (
          await rl.question("body (single line; edit the file for multi-line): ")
        ).trim();
        rl.close();

        const allowedTools = allowedRaw
          ? allowedRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        if (!["none", "local", "external", "destructive"].includes(sideEffects)) {
          printErr(`invalid sideEffects: ${sideEffects}`);
          process.exit(1);
        }
        if (!/^[a-z][a-z0-9_-]+$/.test(name)) {
          printErr(`invalid skill name: ${name} (must match /^[a-z][a-z0-9_-]+$/)`);
          process.exit(1);
        }

        const { SkillWriter } = await import("@/agent");
        const dir = resolve(opts.dir ?? projectDir());
        const writer = new SkillWriter(dir);
        const { path } = await writer.write({
          name,
          description,
          parameters: { type: "object", properties: {}, required: [] },
          ...(allowedTools !== undefined ? { allowedTools } : {}),
          sideEffects: sideEffects as "none" | "local" | "external" | "destructive",
          requiresLive: requiresLiveRaw === "y" || requiresLiveRaw === "yes",
          body: body || "TODO: describe what this skill should do.",
        });
        printLine(`wrote ${path}`);
      } finally {
        rl.close();
      }
    });

  skillsCmd
    .command("remove")
    .description("remove a skill file")
    .argument("<name>")
    .option("--user", "remove from user dir (~/.strand/skills) instead of project")
    .action(async (name: string, opts: { user?: boolean }) => {
      const { SkillWriter } = await import("@/agent");
      const dir = opts.user ? userDir() : projectDir();
      const writer = new SkillWriter(dir);
      const removed = await writer.remove(name);
      if (!removed) {
        printErr(`not found: ${name} in ${dir}`);
        process.exit(1);
      }
      printLine(`removed ${join(dir, `${name}.skill.md`)}`);
    });

  // ─── Pending queue (autonomous skill creation) ─────────────────────────
  const pendingCmd = skillsCmd
    .command("pending")
    .description("manage queued skill proposals from autonomous creation");

  pendingCmd
    .command("list")
    .description("list pending skill proposals")
    .option("-s, --status <s>", "pending | approved | rejected | installed", "pending")
    .action(async (opts: { status: string }) => {
      const agent = await import("@/agent");
      const store = agent.makeSqliteSkillProposalStore();
      const status = opts.status as "pending" | "approved" | "rejected" | "installed";
      const proposals = await store.listByStatus(status);
      if (proposals.length === 0) {
        printLine(`no ${status} proposals`);
        return;
      }
      printTable(proposals, [
        { header: "id", value: (p) => p.id, maxWidth: 28 },
        { header: "name", value: (p) => p.proposedName, maxWidth: 24 },
        { header: "side", value: (p) => p.proposedDoc.sideEffects ?? "local", maxWidth: 11 },
        { header: "created", value: (p) => p.createdAt.slice(0, 19), maxWidth: 20 },
        { header: "reasoning", value: (p) => truncate(p.reasoning, 60), maxWidth: 60 },
      ]);
    });

  pendingCmd
    .command("show")
    .description("print a proposal's full SkillDocument + reasoning")
    .argument("<id>")
    .action(async (id: string) => {
      const agent = await import("@/agent");
      const store = agent.makeSqliteSkillProposalStore();
      const p = await store.load(id);
      if (!p) {
        printErr(`not found: ${id}`);
        process.exit(1);
      }
      printLine(`id: ${p.id}`);
      printLine(`status: ${p.status}`);
      printLine(`name: ${p.proposedName}`);
      printLine(`description: ${p.proposedDescription}`);
      printLine(`sideEffects: ${p.proposedDoc.sideEffects ?? "local"}`);
      printLine(`requiresLive: ${Boolean(p.proposedDoc.requiresLive)}`);
      printLine(`allowedTools: ${(p.proposedDoc.allowedTools ?? []).join(", ") || "(none)"}`);
      printLine(`reasoning: ${p.reasoning}`);
      printLine("---");
      printLine("body:");
      printLine(p.proposedDoc.body);
    });

  pendingCmd
    .command("approve")
    .description("install a pending proposal as a skill")
    .argument("<id>")
    .option("--dir <path>", "target dir (default ./.strand/skills)")
    .action(async (id: string, opts: { dir?: string }) => {
      const agent = await import("@/agent");
      const store = agent.makeSqliteSkillProposalStore();
      const p = await store.load(id);
      if (!p) {
        printErr(`not found: ${id}`);
        process.exit(1);
      }
      if (p.status !== "pending") {
        printErr(`not pending: ${id} (status=${p.status})`);
        process.exit(1);
      }
      const dir = resolve(opts.dir ?? projectDir());
      const writer = new agent.SkillWriter(dir);
      const { path } = await writer.write(p.proposedDoc);
      await store.updateStatus(id, "installed", "human");
      printLine(`installed ${p.proposedName} → ${path}`);
    });

  pendingCmd
    .command("reject")
    .description("mark a proposal rejected (no disk write)")
    .argument("<id>")
    .action(async (id: string) => {
      const agent = await import("@/agent");
      const store = agent.makeSqliteSkillProposalStore();
      const p = await store.load(id);
      if (!p) {
        printErr(`not found: ${id}`);
        process.exit(1);
      }
      if (p.status !== "pending") {
        printErr(`not pending: ${id} (status=${p.status})`);
        process.exit(1);
      }
      await store.updateStatus(id, "rejected", "human");
      printLine(`rejected ${p.proposedName}`);
    });

  skillsCmd
    .command("validate")
    .description("load all skills and report parse errors")
    .action(async () => {
      const { loadSkills } = await import("@/agent");
      const { skills, errors, shadowed } = await loadSkills({
        projectDir: projectDir(),
        userDir: userDir(),
      });
      printLine(`skills: ${skills.length}`);
      if (shadowed.length > 0) {
        printLine(`shadowed (project wins): ${shadowed.join(", ")}`);
      }
      if (errors.length === 0) {
        printLine("ok: no errors");
        return;
      }
      printLine(`errors: ${errors.length}`);
      for (const e of errors) {
        printLine(`  ${e.path}: ${e.error}`);
      }
      process.exit(1);
    });
}
