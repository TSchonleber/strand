import type { BashResult, ComputerExecutor, Screenshot, TextEditorCommand } from "@/agent";
import type { AgentContext, Budget, BudgetSnapshot, ToolRegistry } from "@/agent/types";
import type { LlmProvider } from "@/clients/llm";

export type BashCall = {
  command: string;
  opts: { timeoutMs?: number; cwd?: string } | undefined;
};

export type BashScript = {
  match: (command: string) => boolean;
  result: Partial<BashResult>;
};

export class FakeExecutor implements ComputerExecutor {
  readonly name = "fake";
  readonly safe = true;
  readonly calls: BashCall[] = [];
  private readonly scripts: BashScript[];

  constructor(scripts: BashScript[] = []) {
    this.scripts = scripts;
  }

  async bash(
    command: string,
    opts: { timeoutMs?: number; cwd?: string } = {},
  ): Promise<BashResult> {
    this.calls.push({ command, opts });
    for (const s of this.scripts) {
      if (s.match(command)) {
        return {
          stdout: s.result.stdout ?? "",
          stderr: s.result.stderr ?? "",
          exitCode: s.result.exitCode ?? 0,
          ...(s.result.truncated !== undefined ? { truncated: s.result.truncated } : {}),
        };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async screenshot(): Promise<Screenshot> {
    return { base64: "", width: 1, height: 1 };
  }
  async cursorPosition() {
    return { x: 0, y: 0 };
  }
  async mouseMove(): Promise<void> {}
  async click(): Promise<void> {}
  async doubleClick(): Promise<void> {}
  async mouseDown(): Promise<void> {}
  async mouseUp(): Promise<void> {}
  async scroll(): Promise<void> {}
  async key(): Promise<void> {}
  async type(): Promise<void> {}
  async wait(): Promise<void> {}
  async textEditor(_command: TextEditorCommand, _args: Record<string, unknown>) {
    return {};
  }
}

class FakeBudget implements Budget {
  check(): void {}
  consumeUsage(): void {}
  consumeToolCall(): void {}
  snapshot(): BudgetSnapshot {
    return { spentUsdTicks: 0, spentTokens: 0, elapsedMs: 0, toolCalls: 0, limits: {} };
  }
  fork(): Budget {
    return new FakeBudget();
  }
}

const fakeProvider: LlmProvider = {
  name: "fake",
  async chat() {
    throw new Error("fake provider");
  },
} as unknown as LlmProvider;

const fakeRegistry: ToolRegistry = {
  register() {},
  unregister() {},
  list() {
    return [];
  },
  get() {
    return undefined;
  },
  allowlist() {
    return fakeRegistry;
  },
};

export function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const base: AgentContext = {
    provider: fakeProvider,
    tools: fakeRegistry,
    budget: new FakeBudget(),
    depth: 0,
  };
  return { ...base, ...overrides };
}
