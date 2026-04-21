import { log } from "@/util/log";
import type { Tool, ToolRegistry } from "./types";

/**
 * Default ToolRegistry — an in-memory name → Tool map with allowlist support.
 *
 * Construct a root registry, `register()` all built-ins, then derive
 * per-agent scoped registries via `allowlist(names)`. The scoped registry
 * shares the underlying map; `register()` on a scoped registry delegates
 * to the root, but `get()` / `list()` only surface the allowed subset.
 */
export class DefaultToolRegistry implements ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  register<A, R>(tool: Tool<A, R>): void {
    if (this.byName.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
    }
    this.byName.set(tool.name, tool as Tool);
    log.debug(
      {
        svc: "agent",
        store: "registry",
        tool: tool.name,
        sideEffects: tool.sideEffects ?? "none",
        requiresLive: tool.requiresLive ?? false,
      },
      "agent.registry.registered",
    );
  }

  unregister(name: string): void {
    this.byName.delete(name);
  }

  list(): readonly Tool[] {
    return [...this.byName.values()];
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  allowlist(names: readonly string[]): ToolRegistry {
    return new ScopedToolRegistry(this, new Set(names));
  }
}

class ScopedToolRegistry implements ToolRegistry {
  constructor(
    private readonly base: DefaultToolRegistry,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  register<A, R>(tool: Tool<A, R>): void {
    // Registration pokes through to the root — scoped registries are read-only
    // on the allowed set but we don't want to break child-registered tools.
    this.base.register(tool);
  }

  unregister(name: string): void {
    this.base.unregister(name);
  }

  list(): readonly Tool[] {
    return this.base.list().filter((t) => this.allowed.has(t.name));
  }

  get(name: string): Tool | undefined {
    if (!this.allowed.has(name)) return undefined;
    return this.base.get(name);
  }

  allowlist(names: readonly string[]): ToolRegistry {
    // Intersection: the child can only further restrict.
    const next = new Set<string>();
    for (const n of names) {
      if (this.allowed.has(n)) next.add(n);
    }
    return new ScopedToolRegistry(this.base, next);
  }
}
