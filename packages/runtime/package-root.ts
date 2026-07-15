import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_PARENT_SEARCH_DEPTH = 12;

function isSelftunePackageRoot(path: string): boolean {
  return (
    existsSync(join(path, "package.json")) &&
    (existsSync(join(path, "skill", "SKILL.md")) || existsSync(join(path, "apps", "cli")))
  );
}

export function findSelftunePackageRoot(startDir = import.meta.dir): string {
  let current = resolve(startDir);
  for (let depth = 0; depth <= MAX_PARENT_SEARCH_DEPTH; depth += 1) {
    if (isSelftunePackageRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return resolve(startDir, "..", "..");
}

export function resolveSelftuneCliEntrypoint(packageRoot = findSelftunePackageRoot()): string {
  const override = process.env.SELFTUNE_SOURCE_ENTRYPOINT?.trim();
  if (override) return resolve(override);

  const candidates = [
    join(packageRoot, "apps", "cli", "src", "main.ts"),
    join(packageRoot, "cli", "selftune", "index.ts"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}
