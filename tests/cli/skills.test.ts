import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(process.cwd(), "src/cli/index.ts");

function runCli(
  args: string[],
  projectSkillsDir: string,
  userSkillsDir: string,
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8",
    // Run from the project root so config/persona.yaml + tsconfig paths
    // resolve. The skills dirs are pointed at tmp paths via env overrides
    // so the test stays hermetic.
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOG_LEVEL: "fatal",
      XAI_API_KEY: "t",
      X_CLIENT_ID: "t",
      X_CLIENT_SECRET: "t",
      STRAND_SKILLS_PROJECT_DIR: projectSkillsDir,
      STRAND_SKILLS_USER_DIR: userSkillsDir,
    },
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe("strand skills CLI", () => {
  let tmpDir: string;
  let projectSkillsDir: string;
  let userSkillsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "strand-skills-cli-"));
    projectSkillsDir = join(tmpDir, "proj");
    userSkillsDir = join(tmpDir, "user");
    mkdirSync(projectSkillsDir, { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("`skills list` on an empty dir prints `no skills`", () => {
    const { code, stdout } = runCli(["skills", "list"], projectSkillsDir, userSkillsDir);
    expect(code).toBe(0);
    expect(stdout).toContain("no skills");
  });

  it("`skills list` shows a skill written by SkillWriter (project)", () => {
    writeFileSync(
      join(projectSkillsDir, "hello.skill.md"),
      [
        "---",
        "name: hello",
        "description: Say hi to the user.",
        "sideEffects: none",
        "---",
        "",
        "Say hi.",
        "",
      ].join("\n"),
    );

    const { code, stdout } = runCli(["skills", "list"], projectSkillsDir, userSkillsDir);
    expect(code).toBe(0);
    expect(stdout).toContain("hello");
    expect(stdout).toContain("project");
    expect(stdout).toContain("Say hi to the user.");
  });

  it("`skills show` prints the raw file contents", () => {
    writeFileSync(
      join(projectSkillsDir, "foo.skill.md"),
      ["---", "name: foo", "description: FOO_MARKER", "---", "", "body", ""].join("\n"),
    );

    const { code, stdout } = runCli(["skills", "show", "foo"], projectSkillsDir, userSkillsDir);
    expect(code).toBe(0);
    expect(stdout).toContain("FOO_MARKER");
    expect(stdout).toContain("path:");
    expect(stdout).toContain("origin: project");
  });

  it("`skills show <missing>` exits 1", () => {
    const { code, stderr } = runCli(["skills", "show", "nothere"], projectSkillsDir, userSkillsDir);
    expect(code).toBe(1);
    expect(stderr).toContain("not found");
  });

  it("`skills validate` reports errors for malformed skills", () => {
    writeFileSync(join(projectSkillsDir, "broken.skill.md"), "no frontmatter here\n");
    const { code, stdout } = runCli(["skills", "validate"], projectSkillsDir, userSkillsDir);
    expect(code).toBe(1);
    expect(stdout).toContain("errors: 1");
  });

  it("`skills remove` deletes a project file", () => {
    writeFileSync(
      join(projectSkillsDir, "gone.skill.md"),
      "---\nname: gone\ndescription: d\n---\n\nbody\n",
    );
    const { code, stdout } = runCli(["skills", "remove", "gone"], projectSkillsDir, userSkillsDir);
    expect(code).toBe(0);
    expect(stdout).toContain("removed");
    const again = runCli(["skills", "list"], projectSkillsDir, userSkillsDir);
    expect(again.stdout).toContain("no skills");
  });

  it("`skills --help` lists subcommands", () => {
    const { code, stdout } = runCli(["skills", "--help"], projectSkillsDir, userSkillsDir);
    expect(code).toBe(0);
    for (const sub of ["list", "show", "add", "remove", "validate"]) {
      expect(stdout).toContain(sub);
    }
  });
});
