import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentContext,
  DefaultToolRegistry,
  SkillWriter,
  type Tool,
  buildGoal,
  createBudget,
  loadSkills,
  parseSkill,
  skillToTool,
} from "@/agent";
import type { LlmCall, LlmProvider, LlmResult, LlmUsage } from "@/clients/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costInUsdTicks: 0,
};

function makeResult<T>(
  outputText: string,
  parsed: T | null,
  overrides: Partial<LlmResult<T>> = {},
): LlmResult<T> {
  return {
    outputText,
    parsed,
    responseId: "resp_test",
    systemFingerprint: null,
    usage: { ...ZERO_USAGE, inputTokens: 50, outputTokens: 25 },
    toolCalls: [],
    rawResponse: {},
    ...overrides,
  };
}

interface ScriptedProvider extends LlmProvider {
  calls: LlmCall[];
}

function scriptedProvider(script: Array<LlmResult<unknown>>): ScriptedProvider {
  let i = 0;
  const calls: LlmCall[] = [];
  return {
    name: "scripted",
    capabilities: {
      structuredOutput: true,
      mcp: false,
      serverSideTools: [],
      batch: false,
      promptCacheKey: false,
      previousResponseId: false,
      functionToolLoop: true,
      computerUse: false,
      maxContextTokens: 100_000,
    },
    async chat<T>(input: LlmCall): Promise<LlmResult<T>> {
      calls.push(input);
      const r = script[i++];
      if (!r) throw new Error(`scripted provider exhausted (call #${i - 1})`);
      return r as LlmResult<T>;
    },
    calls,
  };
}

function echoTool(): Tool<{ text: string }, { echoed: string }> {
  return {
    name: "echo",
    description: "echoes",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    sideEffects: "none",
    async execute(args) {
      return { echoed: args.text };
    },
  };
}

function makeCtx(provider: LlmProvider): AgentContext {
  const registry = new DefaultToolRegistry();
  registry.register(echoTool());
  return { provider, tools: registry, budget: createBudget(), depth: 0 };
}

describe("skills — loader", () => {
  let tmpRoot: string;
  let projectDir: string;
  let userDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "strand-skills-"));
    projectDir = join(tmpRoot, "proj", ".strand", "skills");
    userDir = join(tmpRoot, "user", ".strand", "skills");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("parses a valid skill", async () => {
    writeFileSync(
      join(projectDir, "greet.skill.md"),
      [
        "---",
        "name: greet",
        "description: Greet someone by name.",
        "parameters:",
        "  type: object",
        "  properties:",
        "    who:",
        "      type: string",
        "  required: [who]",
        "sideEffects: none",
        "---",
        "",
        "Say hello to {{who}}.",
        "",
      ].join("\n"),
    );

    const { skills, errors } = await loadSkills({ projectDir, userDir: null });
    expect(errors).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("greet");
    expect(skills[0]?.origin).toBe("project");
    expect(skills[0]?.sideEffects).toBe("none");
    expect(skills[0]?.body).toBe("Say hello to {{who}}.");
  });

  it("records an error (does not throw) on missing front-matter", async () => {
    writeFileSync(join(projectDir, "noheader.skill.md"), "just body, no frontmatter\n");
    const { skills, errors } = await loadSkills({ projectDir, userDir: null });
    expect(skills).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/front-matter/);
  });

  it("rejects invalid name format", async () => {
    writeFileSync(
      join(projectDir, "bad.skill.md"),
      "---\nname: BadName\ndescription: x\n---\n\nbody\n",
    );
    const { errors } = await loadSkills({ projectDir, userDir: null });
    expect(errors[0]?.error).toMatch(/invalid skill name/);
  });

  it("shadows user skills with project skills of the same name", async () => {
    const body = (origin: string) =>
      `---\nname: test-build\ndescription: ${origin} variant\n---\n\n${origin} body\n`;
    writeFileSync(join(projectDir, "test-build.skill.md"), body("project"));
    writeFileSync(join(userDir, "test-build.skill.md"), body("user"));

    const { skills, shadowed } = await loadSkills({ projectDir, userDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.origin).toBe("project");
    expect(skills[0]?.description).toBe("project variant");
    expect(shadowed).toEqual(["test-build"]);
  });

  it("registers skills as tools into the passed registry", async () => {
    writeFileSync(
      join(projectDir, "foo.skill.md"),
      "---\nname: foo\ndescription: foo skill\n---\n\nrun foo\n",
    );
    const registry = new DefaultToolRegistry();
    registry.register(echoTool());
    const { skills } = await loadSkills({ projectDir, userDir: null, registry });
    expect(skills).toHaveLength(1);
    expect(registry.get("foo")?.name).toBe("foo");
    expect(registry.get("foo")?.description).toBe("foo skill");
  });
});

describe("skills — parseSkill corner cases", () => {
  it("permits `---` rulers inside the body", () => {
    const raw = [
      "---",
      "name: with-ruler",
      "description: desc",
      "---",
      "",
      "first section",
      "",
      "---",
      "",
      "second section",
      "",
    ].join("\n");
    const out = parseSkill(raw, "project", "/fake/path.skill.md");
    if (out instanceof Error) throw new Error(`parseSkill failed: ${out.message}`);
    expect(out.body).toContain("second section");
    expect(out.body).toContain("---");
  });
});

describe("skills — buildGoal interpolation", () => {
  it("replaces present args and marks missing ones", () => {
    const skill = {
      name: "t",
      description: "d",
      parameters: { type: "object" } as Record<string, unknown>,
      body: "hello {{who}} — re: {{topic}}",
      origin: "project" as const,
      sourcePath: "/x",
      sideEffects: "local" as const,
      requiresLive: false,
    };
    const goal = buildGoal(skill, { who: "world" });
    expect(goal).toBe("hello world — re: {{topic: MISSING}}");
  });

  it("stringifies non-string args", () => {
    const skill = {
      name: "t",
      description: "d",
      parameters: { type: "object" } as Record<string, unknown>,
      body: "n={{n}} list={{xs}}",
      origin: "project" as const,
      sourcePath: "/x",
      sideEffects: "local" as const,
      requiresLive: false,
    };
    const goal = buildGoal(skill, { n: 42, xs: [1, 2] });
    expect(goal).toBe("n=42 list=[1,2]");
  });
});

describe("skills — skillToTool synthesis", () => {
  it("copies name / description / parameters / sideEffects / requiresLive", () => {
    const registry = new DefaultToolRegistry();
    registry.register(echoTool());
    const tool = skillToTool(
      {
        name: "t",
        description: "desc",
        parameters: { type: "object", properties: { q: { type: "string" } } },
        body: "body",
        origin: "project",
        sourcePath: "/x",
        sideEffects: "external",
        requiresLive: true,
      },
      registry,
    );
    expect(tool.name).toBe("t");
    expect(tool.description).toBe("desc");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(tool.sideEffects).toBe("external");
    expect(tool.requiresLive).toBe(true);
  });

  it("filters unknown tools from allowedTools at load time", () => {
    const registry = new DefaultToolRegistry();
    registry.register(echoTool());
    const warnings: Array<{ msg: string; detail: Record<string, unknown> }> = [];
    const tool = skillToTool(
      {
        name: "t",
        description: "desc",
        parameters: { type: "object" },
        allowedTools: ["echo", "does_not_exist"],
        body: "body",
        origin: "project",
        sourcePath: "/x",
      },
      registry,
      (msg, detail) => warnings.push({ msg, detail }),
    );
    expect(tool).toBeDefined();
    expect(
      warnings.find((w) => w.msg === "skills.allowed_tools_filtered")?.detail["dropped"],
    ).toEqual(["does_not_exist"]);
  });
});

describe("skills — execute path spawns nested runPlan", () => {
  it("passes the interpolated body as the nested goal and returns finalOutput", async () => {
    const provider = scriptedProvider([
      makeResult("", { steps: [{ goal: "only step", allowedTools: ["echo"] }] }),
      makeResult("skill did its thing", null),
      makeResult("", { achieved: true, reasoning: "ok" }),
    ]);
    const ctx = makeCtx(provider);

    const skillTool = skillToTool(
      {
        name: "my_skill",
        description: "test skill",
        parameters: { type: "object", properties: { who: { type: "string" } } },
        body: "greet {{who}} now",
        origin: "project",
        sourcePath: "/x",
      },
      ctx.tools,
    );

    const result = await skillTool.execute({ who: "Alice" }, ctx);
    expect(result).toContain("skill did its thing");
    // First call is decompose — its user message (index 2) is "Goal:\n...".
    const decomposeGoalMsg = (provider.calls[0]?.messages[2]?.content ?? "") as string;
    expect(decomposeGoalMsg).toContain("greet Alice now");
  });

  it("throws a tool error when the nested runPlan does not complete", async () => {
    // Scripted provider errors out by running out of scripted responses.
    // runPlan will catch the throw inside decompose and return stopReason=error.
    const provider = scriptedProvider([]);
    const ctx = makeCtx(provider);

    const skillTool = skillToTool(
      {
        name: "bad_skill",
        description: "desc",
        parameters: { type: "object" },
        body: "do a thing",
        origin: "project",
        sourcePath: "/x",
      },
      ctx.tools,
    );

    await expect(skillTool.execute({}, ctx)).rejects.toThrow(/skill 'bad_skill'/);
  });

  it("applies allowedTools filter to the child's tool registry", async () => {
    const provider = scriptedProvider([
      makeResult("", { steps: [{ goal: "s", allowedTools: ["echo"] }] }),
      makeResult("done", null),
      makeResult("", { achieved: true, reasoning: "ok" }),
    ]);
    const registry = new DefaultToolRegistry();
    registry.register(echoTool());
    registry.register({
      name: "forbidden",
      description: "should not be visible to child",
      parameters: { type: "object" },
      async execute() {
        return "nope";
      },
    });
    const ctx: AgentContext = {
      provider,
      tools: registry,
      budget: createBudget(),
      depth: 0,
    };

    const skillTool = skillToTool(
      {
        name: "scoped",
        description: "scoped skill",
        parameters: { type: "object" },
        allowedTools: ["echo"],
        body: "body",
        origin: "project",
        sourcePath: "/x",
      },
      registry,
    );

    await skillTool.execute({}, ctx);

    // The decompose user prompt contains the child's tool catalog. Only
    // `echo` should appear — `forbidden` must have been filtered out.
    const decomposeToolMsg = (provider.calls[0]?.messages[1]?.content ?? "") as string;
    expect(decomposeToolMsg).toContain("echo");
    expect(decomposeToolMsg).not.toContain("forbidden");
  });

  it("respects maxDepth — depth past cap returns max_depth stop without a chat call", async () => {
    const provider = scriptedProvider([]); // would throw if called
    const ctx = makeCtx(provider);
    (ctx as { depth: number }).depth = 99;

    const skillTool = skillToTool(
      {
        name: "deep",
        description: "deep skill",
        parameters: { type: "object" },
        body: "body",
        origin: "project",
        sourcePath: "/x",
      },
      ctx.tools,
    );

    await expect(skillTool.execute({}, ctx)).rejects.toThrow(/stopReason=max_depth/);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("SkillWriter", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "strand-skill-writer-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes a skill file that round-trips through the loader", async () => {
    const writer = new SkillWriter(tmpRoot);
    const { path } = await writer.write({
      name: "round-trip",
      description: "round-trip test",
      parameters: { type: "object", properties: {} },
      allowedTools: ["echo"],
      sideEffects: "local",
      requiresLive: false,
      body: "do the thing\nwith {{arg}}",
    });
    expect(path.endsWith("round-trip.skill.md")).toBe(true);

    const { skills, errors } = await loadSkills({
      projectDir: tmpRoot,
      userDir: null,
    });
    expect(errors).toEqual([]);
    expect(skills[0]?.name).toBe("round-trip");
    expect(skills[0]?.body).toContain("with {{arg}}");
  });

  it("remove() returns false for missing files", async () => {
    const writer = new SkillWriter(tmpRoot);
    expect(await writer.remove("nope")).toBe(false);
  });
});
