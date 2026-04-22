import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function resolveVersion(): string {
  try {
    // Walk up from this module to find the package.json. Works in dev (tsx)
    // and from dist (compiled). We bail on any error — version is
    // cosmetic in the welcome banner.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      resolve(here, "../../../package.json"),
      resolve(here, "../../package.json"),
      resolve(here, "../package.json"),
      resolve(here, "package.json"),
    ]) {
      try {
        const raw = readFileSync(candidate, "utf8");
        const pkg = JSON.parse(raw) as { version?: string };
        if (typeof pkg.version === "string") return pkg.version;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

export const version = resolveVersion();
