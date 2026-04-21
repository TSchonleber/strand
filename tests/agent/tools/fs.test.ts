import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeFsRead, makeFsSearch, makeFsWrite } from "@/agent/tools/fs";
import { describe, expect, it } from "vitest";
import { makeCtx } from "./helpers";

async function mkTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "strand-fs-"));
}

describe("fs_read", () => {
  it("reads a file and reports not truncated when under cap", async () => {
    const dir = await mkTmp();
    const p = join(dir, "a.txt");
    await writeFile(p, "hello world", "utf8");
    const tool = makeFsRead();
    const out = await tool.execute({ path: p }, makeCtx());
    expect(out.content).toBe("hello world");
    expect(out.truncated).toBe(false);
    expect(out.path).toBe(resolve(p));
  });

  it("truncates at maxBytes", async () => {
    const dir = await mkTmp();
    const p = join(dir, "big.txt");
    await writeFile(p, "abcdefghij", "utf8");
    const tool = makeFsRead();
    const out = await tool.execute({ path: p, maxBytes: 4 }, makeCtx());
    expect(out.content).toBe("abcd");
    expect(out.truncated).toBe(true);
  });

  it("refuses paths outside ctx.metadata.workdir", async () => {
    const wd = await mkTmp();
    const other = await mkTmp();
    const bad = join(other, "x.txt");
    await writeFile(bad, "nope", "utf8");
    const tool = makeFsRead();
    await expect(
      tool.execute({ path: bad }, makeCtx({ metadata: { workdir: wd } })),
    ).rejects.toThrow(/outside workdir/);
  });
});

describe("fs_write", () => {
  it("writes a file and creates parent dirs", async () => {
    const dir = await mkTmp();
    const p = join(dir, "nested", "deep", "out.txt");
    const tool = makeFsWrite();
    const out = await tool.execute({ path: p, content: "ciao" }, makeCtx());
    expect(out.bytes).toBe(4);
    const body = await readFile(p, "utf8");
    expect(body).toBe("ciao");
  });

  it("refuses writes outside workdir", async () => {
    const wd = await mkTmp();
    const other = await mkTmp();
    const bad = join(other, "out.txt");
    const tool = makeFsWrite();
    await expect(
      tool.execute({ path: bad, content: "x" }, makeCtx({ metadata: { workdir: wd } })),
    ).rejects.toThrow(/outside workdir/);
  });
});

describe("fs_search", () => {
  it("matches case-insensitively and skips node_modules", async () => {
    const dir = await mkTmp();
    await writeFile(join(dir, "a.ts"), "const x = 'Hello World';\nconsole.log(x);\n", "utf8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "idx.js"), "hello", "utf8");
    const tool = makeFsSearch();
    const out = await tool.execute(
      { query: "hello", path: dir },
      makeCtx({ metadata: { workdir: dir } }),
    );
    expect(out.matches.length).toBeGreaterThanOrEqual(1);
    // node_modules skipped
    expect(out.matches.some((m) => m.file.includes("node_modules"))).toBe(false);
    expect(out.matches[0]?.preview).toMatch(/Hello World/);
  });

  it("honors regex=true", async () => {
    const dir = await mkTmp();
    await writeFile(join(dir, "a.txt"), "foo\nfoobar\nbaz\n", "utf8");
    const tool = makeFsSearch();
    const out = await tool.execute(
      { query: "^foo$", path: dir, regex: true },
      makeCtx({ metadata: { workdir: dir } }),
    );
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.line).toBe(1);
  });

  it("caps at maxResults", async () => {
    const dir = await mkTmp();
    const lines = Array.from({ length: 10 }, () => "needle").join("\n");
    await writeFile(join(dir, "a.txt"), lines, "utf8");
    const tool = makeFsSearch();
    const out = await tool.execute(
      { query: "needle", path: dir, maxResults: 3 },
      makeCtx({ metadata: { workdir: dir } }),
    );
    expect(out.matches).toHaveLength(3);
  });
});
