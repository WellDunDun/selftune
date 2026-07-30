import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Workspace type detection
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set(["node_modules", ".git", ".hg", "dist", "build", ".next", ".cache"]);

export interface WorkspaceInfo {
  type: "single-skill" | "multi-skill" | "monorepo" | "unknown";
  skillCount: number;
  skillPaths: string[];
  isMonorepo: boolean;
  hasExistingHooks: boolean;
  suggestedTemplate: "single-skill" | "multi-skill" | null;
}

/**
 * Recursively find SKILL.md files under a root directory,
 * skipping ignored directories (node_modules, .git, etc.).
 */
function findSkillFiles(dir: string, maxDepth = 8, depth = 0): string[] {
  if (depth > maxDepth) return [];
  if (!existsSync(dir)) return [];

  const results: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        results.push(...findSkillFiles(join(dir, entry.name), maxDepth, depth + 1));
      } else if (entry.name === "SKILL.md") {
        results.push(join(dir, entry.name));
      }
    }
  } catch {
    // Permission errors, etc. — skip
  }

  return results;
}

/**
 * Detect whether the root directory is a monorepo by checking for
 * package.json workspaces or pnpm-workspace.yaml.
 */
function detectMonorepo(rootDir: string): boolean {
  // Check package.json workspaces field
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.workspaces) return true;
    } catch {
      // invalid JSON — skip
    }
  }

  // Check pnpm-workspace.yaml
  if (existsSync(join(rootDir, "pnpm-workspace.yaml"))) return true;

  // Check lerna.json
  if (existsSync(join(rootDir, "lerna.json"))) return true;

  return false;
}

/**
 * Detect whether the project has existing selftune hooks configured.
 */
function detectExistingHooks(rootDir: string): boolean {
  const hooksDir = join(rootDir, "cli", "selftune", "hooks");
  if (!existsSync(hooksDir)) return false;

  try {
    const entries = readdirSync(hooksDir);
    return entries.some((e) => e.endsWith(".ts") || e.endsWith(".js"));
  } catch {
    return false;
  }
}

/**
 * Scan a project root and detect the workspace type, skill layout,
 * and suggest an appropriate template.
 */
export function detectWorkspaceType(rootDir: string): WorkspaceInfo {
  const skillPaths = findSkillFiles(rootDir);
  const isMonorepo = detectMonorepo(rootDir);
  const hasExistingHooks = detectExistingHooks(rootDir);
  const skillCount = skillPaths.length;

  let type: WorkspaceInfo["type"];
  let suggestedTemplate: WorkspaceInfo["suggestedTemplate"];

  if (isMonorepo) {
    type = "monorepo";
    suggestedTemplate = "multi-skill";
  } else if (skillCount === 0) {
    type = "unknown";
    suggestedTemplate = null;
  } else if (skillCount === 1) {
    type = "single-skill";
    suggestedTemplate = "single-skill";
  } else {
    type = "multi-skill";
    suggestedTemplate = "multi-skill";
  }

  return {
    type,
    skillCount,
    skillPaths,
    isMonorepo,
    hasExistingHooks,
    suggestedTemplate,
  };
}
