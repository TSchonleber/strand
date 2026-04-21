import { type DockerExecFn, type DockerExecResult, DockerExecutor } from "@/agent";
import { describe, expect, it } from "vitest";

/**
 * DockerExecutor unit tests. Docker is NEVER actually invoked — the executor
 * accepts an injectable `execFile` runner (`DockerExecFn`) that tests plug
 * with `vi.fn()`. Every assertion inspects the argv the runner was called
 * with, plus the parsed return.
 */

interface Script {
  // Matchers are applied in order — first match wins.
  match: (args: readonly string[]) => boolean;
  result: { stdout?: Buffer | string; stderr?: Buffer | string; exitCode?: number };
}

const toBuf = (v: Buffer | string | undefined): Buffer =>
  v === undefined ? Buffer.alloc(0) : Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8");

function ok(): DockerExecResult {
  return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
}

function makeRunner(scripts: Script[]): {
  fn: DockerExecFn;
  calls: Array<{ file: string; args: readonly string[]; opts: unknown }>;
} {
  const calls: Array<{ file: string; args: readonly string[]; opts: unknown }> = [];
  const fn: DockerExecFn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    for (const s of scripts) {
      if (s.match(args)) {
        return {
          stdout: toBuf(s.result.stdout),
          stderr: toBuf(s.result.stderr),
          exitCode: s.result.exitCode ?? 0,
        };
      }
    }
    return ok();
  };
  return { fn, calls };
}

/** Helper: running-container script so ensureRunning() always passes. */
const runningScript: Script = {
  match: (a) => a[0] === "inspect",
  result: { stdout: "true\n", exitCode: 0 },
};

/** Pull an argv out of a `docker exec ... <container> cmd...` call. */
function execArgv(args: readonly string[]): string[] {
  // shape: ["exec", "-e", "DISPLAY=:1", ..., "<container>", ...cmd]
  const containerIdx = args.indexOf("strand-sandbox");
  return [...args.slice(containerIdx + 1)];
}

describe("DockerExecutor", () => {
  it("safe is false until markSafe() is called", () => {
    const exec = new DockerExecutor({ execFile: makeRunner([]).fn });
    expect(exec.safe).toBe(false);
    exec.markSafe();
    expect(exec.safe).toBe(true);
  });

  it("click() invokes docker exec xdotool mousemove <x> <y> click 1", async () => {
    const { fn, calls } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await exec.click(100, 200, "left");

    const execCall = calls.find((c) => c.args.includes("xdotool"));
    expect(execCall).toBeDefined();
    const argv = execArgv(execCall?.args ?? []);
    expect(argv).toEqual(["xdotool", "mousemove", "100", "200", "click", "1"]);
  });

  it("right_click uses button 3, middle_click uses button 2", async () => {
    const { fn, calls } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await exec.click(10, 20, "right");
    await exec.click(30, 40, "middle");

    const runs = calls.filter((c) => c.args.includes("xdotool"));
    expect(execArgv(runs[0]?.args ?? [])).toEqual([
      "xdotool",
      "mousemove",
      "10",
      "20",
      "click",
      "3",
    ]);
    expect(execArgv(runs[1]?.args ?? [])).toEqual([
      "xdotool",
      "mousemove",
      "30",
      "40",
      "click",
      "2",
    ]);
  });

  it("doubleClick uses --repeat 2", async () => {
    const { fn, calls } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await exec.doubleClick(5, 5);

    const run = calls.find((c) => c.args.includes("xdotool"));
    expect(execArgv(run?.args ?? [])).toEqual([
      "xdotool",
      "mousemove",
      "5",
      "5",
      "click",
      "--repeat",
      "2",
      "1",
    ]);
  });

  it("scroll maps direction → button and uses --repeat", async () => {
    const { fn, calls } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await exec.scroll("down", 3);

    const run = calls.find((c) => c.args.includes("xdotool"));
    expect(execArgv(run?.args ?? [])).toEqual(["xdotool", "click", "--repeat", "3", "5"]);
  });

  it("type() passes text through argv (no shell interpolation) with -- terminator", async () => {
    const { fn, calls } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await exec.type("hello world $(rm -rf /)");

    const run = calls.find((c) => c.args.includes("xdotool"));
    const argv = execArgv(run?.args ?? []);
    expect(argv).toEqual(["xdotool", "type", "--delay", "40", "--", "hello world $(rm -rf /)"]);
  });

  it("key() routes to xdotool key with -- terminator", async () => {
    const { fn, calls } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await exec.key("ctrl+a");

    const run = calls.find((c) => c.args.includes("xdotool"));
    expect(execArgv(run?.args ?? [])).toEqual(["xdotool", "key", "--", "ctrl+a"]);
  });

  it("cursorPosition parses xdotool --shell output", async () => {
    const shellOut = "X=412\nY=287\nSCREEN=0\nWINDOW=1234\n";
    const { fn } = makeRunner([
      runningScript,
      {
        match: (a) => a.includes("getmouselocation"),
        result: { stdout: shellOut, exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    const pos = await exec.cursorPosition();
    expect(pos).toEqual({ x: 412, y: 287 });
  });

  it("bash() passes command via argv and honors timeoutMs", async () => {
    const { fn, calls } = makeRunner([
      runningScript,
      {
        match: (a) => a.includes("bash"),
        result: { stdout: "hi\n", stderr: "", exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    const res = await exec.bash("echo hi", { timeoutMs: 5000 });

    expect(res).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });
    const run = calls.find((c) => {
      const argv = execArgv(c.args);
      return argv[0] === "bash";
    });
    expect(run).toBeDefined();
    const argv = execArgv(run?.args ?? []);
    expect(argv).toEqual(["bash", "-c", "echo hi"]);
    expect((run?.opts as { timeoutMs?: number })?.timeoutMs).toBe(5000);
  });

  it("bash() truncates stdout above 64KB cap and sets truncated=true", async () => {
    const big = Buffer.alloc(80 * 1024, "a"); // 80KB of 'a'
    const { fn } = makeRunner([
      runningScript,
      {
        match: (a) => a.includes("bash"),
        result: { stdout: big, exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    const res = await exec.bash("yes");
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.stdout, "utf8")).toBe(64 * 1024);
  });

  it("bash() throws when command exceeds 16KB cap", async () => {
    const { fn } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    const huge = "x".repeat(17 * 1024);
    await expect(exec.bash(huge)).rejects.toThrow(/16384 byte cap/);
  });

  it("screenshot() calls scrot and parses PNG dimensions from buffer", async () => {
    // Build a minimal PNG header with width=640, height=480.
    const png = Buffer.alloc(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
    png.writeUInt32BE(13, 8); // IHDR length
    png.write("IHDR", 12, 4, "ascii");
    png.writeUInt32BE(640, 16); // width
    png.writeUInt32BE(480, 20); // height

    const { fn, calls } = makeRunner([
      runningScript,
      {
        match: (a) => a.includes("scrot"),
        result: { stdout: png, exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    const shot = await exec.screenshot();
    expect(shot.width).toBe(640);
    expect(shot.height).toBe(480);
    expect(shot.base64).toBe(png.toString("base64"));

    const run = calls.find((c) => c.args.includes("scrot"));
    expect(execArgv(run?.args ?? [])).toEqual(["scrot", "-o", "/dev/stdout"]);
  });

  it("screenshot() throws when scrot output is not a PNG", async () => {
    const { fn } = makeRunner([
      runningScript,
      {
        match: (a) => a.includes("scrot"),
        result: { stdout: Buffer.from("not a png"), exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await expect(exec.screenshot()).rejects.toThrow(/not a PNG/);
  });

  it("textEditor view invokes docker exec cat <path> inside container", async () => {
    const { fn, calls } = makeRunner([
      runningScript,
      {
        match: (a) => a.includes("cat"),
        result: { stdout: "line one\nline two\n", exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    const out = await exec.textEditor("view", { path: "/a.txt" });
    expect(out["path"]).toBe("/a.txt");
    expect(out["content"]).toBe("line one\nline two\n");
    expect(out["numbered"]).toBe("1\tline one\n2\tline two\n3\t");

    const run = calls.find((c) => execArgv(c.args)[0] === "cat");
    expect(execArgv(run?.args ?? [])).toEqual(["cat", "/a.txt"]);
  });

  it("textEditor create writes via tee with stdin, captures backup for undo", async () => {
    // first call: inspect (running). Second: cat /f.txt (ENOENT → empty). Third: tee write.
    let catCalls = 0;
    const { fn, calls } = makeRunner([
      runningScript,
      {
        match: (a) => {
          if (execArgv(a)[0] === "cat") {
            catCalls++;
            return true;
          }
          return false;
        },
        result: { stdout: "", stderr: "no such file", exitCode: 1 },
      },
      {
        match: (a) => a.includes("tee"),
        result: { stdout: "hello", exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    const out = await exec.textEditor("create", { path: "/f.txt", file_text: "hello" });
    expect(out["created"]).toBe(true);

    const teeRun = calls.find((c) => c.args.includes("tee"));
    expect(teeRun).toBeDefined();
    expect((teeRun?.opts as { input?: string })?.input).toBe("hello");
    // -i is passed for stdin attachment on docker exec
    expect(teeRun?.args).toContain("-i");
    expect(catCalls).toBe(1);
  });

  it("textEditor str_replace rejects when old_str not unique", async () => {
    const content = "foo bar foo";
    const { fn } = makeRunner([
      runningScript,
      {
        match: (a) => execArgv(a)[0] === "cat",
        result: { stdout: content, exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await expect(
      exec.textEditor("str_replace", { path: "/f.txt", old_str: "foo", new_str: "baz" }),
    ).rejects.toThrow(/more than once/);
  });

  it("textEditor str_replace rejects when old_str absent", async () => {
    const { fn } = makeRunner([
      runningScript,
      {
        match: (a) => execArgv(a)[0] === "cat",
        result: { stdout: "nothing here", exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await expect(
      exec.textEditor("str_replace", { path: "/f.txt", old_str: "ghost", new_str: "x" }),
    ).rejects.toThrow(/not found/);
  });

  it("textEditor undo_edit restores prior content after a create", async () => {
    // First create (existing file has 'old'); then undo; expect tee called with 'old'.
    let catSeen = 0;
    const { fn, calls } = makeRunner([
      runningScript,
      {
        match: (a) => {
          if (execArgv(a)[0] === "cat") {
            catSeen++;
            return true;
          }
          return false;
        },
        result: { stdout: "old", exitCode: 0 },
      },
      { match: (a) => a.includes("tee"), result: { exitCode: 0 } },
    ]);
    const exec = new DockerExecutor({ execFile: fn });
    (exec as unknown as { started: boolean }).started = true;

    await exec.textEditor("create", { path: "/f.txt", file_text: "new" });
    await exec.textEditor("undo_edit", { path: "/f.txt" });

    const teeCalls = calls.filter((c) => c.args.includes("tee"));
    expect(teeCalls).toHaveLength(2);
    expect((teeCalls[0]?.opts as { input?: string })?.input).toBe("new");
    expect((teeCalls[1]?.opts as { input?: string })?.input).toBe("old");
    expect(catSeen).toBeGreaterThanOrEqual(1);
  });

  it("fails loudly when container is not running and autoStart is false", async () => {
    const { fn } = makeRunner([
      {
        match: (a) => a.includes("inspect"),
        result: { stdout: "false\n", exitCode: 0 },
      },
    ]);
    const exec = new DockerExecutor({ execFile: fn });

    await expect(exec.click(1, 2)).rejects.toThrow(/not running/);
  });

  it("autoStart=true pulls and runs the container on first action", async () => {
    const { fn, calls } = makeRunner([
      // First inspect returns not-running so ensureRunning triggers start().
      {
        match: (a) => a[0] === "inspect",
        result: { stdout: "false\n", exitCode: 0 },
      },
      { match: (a) => a[0] === "pull", result: { exitCode: 0 } },
      { match: (a) => a[0] === "run", result: { stdout: "abc123\n", exitCode: 0 } },
    ]);
    const exec = new DockerExecutor({ execFile: fn, autoStart: true });

    await exec.mouseMove(0, 0);

    expect(calls.some((c) => c.args[0] === "pull")).toBe(true);
    expect(calls.some((c) => c.args[0] === "run")).toBe(true);
  });

  it("stop() invokes docker stop <container>", async () => {
    const { fn, calls } = makeRunner([{ match: (a) => a[0] === "stop", result: { exitCode: 0 } }]);
    const exec = new DockerExecutor({ execFile: fn });

    await exec.stop();
    const stopCall = calls.find((c) => c.args[0] === "stop");
    expect(stopCall?.args).toContain("strand-sandbox");
  });

  it("DISPLAY env is set on every exec (not host display)", async () => {
    const { fn, calls } = makeRunner([runningScript]);
    const exec = new DockerExecutor({ execFile: fn, display: ":7" });
    (exec as unknown as { started: boolean }).started = true;

    await exec.mouseMove(1, 2);
    const run = calls.find((c) => c.args.includes("xdotool"));
    expect(run?.args).toContain("DISPLAY=:7");
  });
});
