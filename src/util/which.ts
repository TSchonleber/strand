import { constants, accessSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Return true if `cmd` is executable — either an absolute path that exists,
 * or resolvable against `$PATH`. Synchronous + dependency-free (used at CLI
 * boot for preflight checks).
 */
export function isExecutable(cmd: string): boolean {
  if (!cmd) return false;
  if (isAbsolute(cmd)) return canExec(cmd);
  const path = process.env["PATH"] ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (canExec(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

function canExec(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
