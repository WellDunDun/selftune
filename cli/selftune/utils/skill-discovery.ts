import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SkillPathMetadata {
  skill_scope: "project" | "global" | "admin" | "system" | "unknown";
  skill_project_root?: string;
  skill_registry_dir?: string;
}

function normalizePath(value: string): string {
  const resolved = resolve(value);
  if (!existsSync(resolved)) return resolved;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsWholeSkillMention(text: string, skillName: string): boolean {
  const trimmedSkillName = skillName.trim();
  if (!text || !trimmedSkillName) return false;

  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_])${escapeRegExp(trimmedSkillName)}([^A-Za-z0-9_]|$)`,
    "i",
  );
  return pattern.test(text);
}

export function extractExplicitSkillMentions(
  text: string,
  knownSkillNames: Iterable<string>,
): Set<string> {
  const names = new Set<string>();
  if (!text) return names;

  const normalizedText = text.trim();
  if (!normalizedText) return names;

  for (const skillName of knownSkillNames) {
    const trimmedSkillName = skillName.trim();
    if (!trimmedSkillName) continue;

    const escapedSkillName = escapeRegExp(trimmedSkillName);
    const patterns = [
      new RegExp(`\\$${escapedSkillName}(?:\\b|$)`, "i"),
      new RegExp(`\\b${escapedSkillName}\\s+skill\\b`, "i"),
      new RegExp(
        `\\b(?:use|using|run|invoke|apply|load|open|read|follow)\\s+${escapedSkillName}\\b`,
        "i",
      ),
      new RegExp(`\\b(?:with|via|through)\\s+${escapedSkillName}\\b`, "i"),
      new RegExp(
        `\\b(?:initialize|init|configure|setup|set up|audit)\\s+${escapedSkillName}\\b`,
        "i",
      ),
    ];

    if (patterns.some((pattern) => pattern.test(normalizedText))) {
      names.add(trimmedSkillName);
    }
  }

  return names;
}

export function findInstalledSkillNames(dirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;

        if (existsSync(join(skillDir, "SKILL.md"))) {
          names.add(entry);
          continue;
        }

        // Codex bundles built-in skills under nested scopes like .system/<skill>/SKILL.md.
        for (const nestedEntry of readdirSync(skillDir)) {
          const nestedSkillDir = join(skillDir, nestedEntry);
          try {
            if (
              statSync(nestedSkillDir).isDirectory() &&
              existsSync(join(nestedSkillDir, "SKILL.md"))
            ) {
              names.add(nestedEntry);
            }
          } catch {
            // Skip unreadable nested entries.
          }
        }
      } catch {
        // Skip entries that can't be stat'd (broken symlinks, permission errors, etc.)
      }
    }
  }
  return names;
}

export function findInstalledSkillPath(skillName: string, dirs: string[]): string | undefined {
  const trimmedName = skillName.trim();
  if (!trimmedName) return undefined;

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    const directPath = join(dir, trimmedName, "SKILL.md");
    if (existsSync(directPath)) {
      try {
        return realpathSync(directPath);
      } catch {
        return directPath;
      }
    }

    try {
      for (const entry of readdirSync(dir)) {
        const nestedSkillPath = join(dir, entry, trimmedName, "SKILL.md");
        if (!existsSync(nestedSkillPath)) continue;
        try {
          return realpathSync(nestedSkillPath);
        } catch {
          return nestedSkillPath;
        }
      }
    } catch {
      // Ignore unreadable directories.
    }
  }

  return undefined;
}

export function findGitRepositoryRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  const seen = new Set<string>();

  while (!seen.has(current)) {
    seen.add(current);
    if (existsSync(join(current, ".git"))) return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

export function findAncestorSkillDirs(
  startDir: string,
  relativeSkillPath: string,
  stopDir?: string,
): string[] {
  const dirs: string[] = [];
  let current = resolve(startDir);
  const seen = new Set<string>();
  const normalizedStopDir = stopDir ? resolve(stopDir) : undefined;

  while (!seen.has(current)) {
    seen.add(current);
    dirs.push(join(current, relativeSkillPath));
    if (normalizedStopDir && current === normalizedStopDir) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs;
}

export function findRepositorySkillDirs(startDir: string): string[] {
  const repoRoot = findGitRepositoryRoot(startDir);
  return findAncestorSkillDirs(startDir, ".agents/skills", repoRoot);
}

export function findRepositoryClaudeSkillDirs(startDir: string): string[] {
  const repoRoot = findGitRepositoryRoot(startDir);
  return findAncestorSkillDirs(startDir, ".claude/skills", repoRoot);
}

export function classifySkillPath(
  skillPath: string,
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = process.env.CODEX_HOME ?? join(homeDir, ".codex"),
): SkillPathMetadata {
  const trimmedPath = skillPath.trim();
  if (!trimmedPath || trimmedPath.startsWith("(") || !trimmedPath.endsWith("SKILL.md")) {
    return { skill_scope: "unknown" };
  }

  const normalizedPath = normalizePath(trimmedPath);
  const normalizedHomeDir = homeDir ? normalizePath(homeDir) : "";
  const globalAgentRegistry = join(homeDir, ".agents", "skills");
  if (normalizedPath.startsWith(`${normalizePath(globalAgentRegistry)}/`)) {
    return {
      skill_scope: "global",
      skill_registry_dir: normalizePath(globalAgentRegistry),
    };
  }

  const globalClaudeRegistry = join(homeDir, ".claude", "skills");
  if (normalizedPath.startsWith(`${normalizePath(globalClaudeRegistry)}/`)) {
    return {
      skill_scope: "global",
      skill_registry_dir: normalizePath(globalClaudeRegistry),
    };
  }

  const systemCodexRegistry = join(codexHome, "skills", ".system");
  if (normalizedPath.startsWith(`${normalizePath(systemCodexRegistry)}/`)) {
    return {
      skill_scope: "system",
      skill_registry_dir: normalizePath(systemCodexRegistry),
    };
  }

  const userCodexRegistry = join(codexHome, "skills");
  if (normalizedPath.startsWith(`${normalizePath(userCodexRegistry)}/`)) {
    return {
      skill_scope: "global",
      skill_registry_dir: normalizePath(userCodexRegistry),
    };
  }

  const adminRegistry = "/etc/codex/skills";
  if (normalizedPath.startsWith(`${normalizePath(adminRegistry)}/`)) {
    return {
      skill_scope: "admin",
      skill_registry_dir: normalizePath(adminRegistry),
    };
  }

  const projectRegistries = ["/.agents/skills/", "/.claude/skills/"];
  for (const marker of projectRegistries) {
    const markerIndex = normalizedPath.lastIndexOf(marker);
    if (markerIndex === -1) continue;

    const projectRoot = normalizePath(normalizedPath.slice(0, markerIndex));
    if (
      !projectRoot ||
      projectRoot === normalizedHomeDir ||
      projectRoot === normalizePath(join(homeDir, ".claude"))
    ) {
      continue;
    }

    return {
      skill_scope: "project",
      skill_project_root: projectRoot,
      skill_registry_dir: `${projectRoot}${marker.slice(0, -1)}`,
    };
  }

  return { skill_scope: "unknown" };
}

const TEST_PATH_SEGMENTS = [
  "/tests/",
  "/__tests__/",
  "/test/",
  "/fixtures/",
  "/sandbox/",
  "/test-data/",
  "/testdata/",
  "/mock/",
  "/mocks/",
];

/**
 * Check if a skill path is inside a test/fixture directory.
 * Used to prevent test fixture skills from leaking into production data.
 */
export function isTestFixturePath(skillPath: string): boolean {
  if (!skillPath) return false;
  const normalized = skillPath.toLowerCase();
  return TEST_PATH_SEGMENTS.some((seg) => normalized.includes(seg));
}

export function extractSkillNamesFromInstructions(
  text: string,
  knownSkillNames?: Iterable<string>,
): Set<string> {
  const names = new Set<string>();
  const knownSkillMap = new Map<string, string>();
  if (knownSkillNames) {
    for (const skillName of knownSkillNames) {
      knownSkillMap.set(skillName.toLowerCase(), skillName);
    }
  }
  let inAvailableSkillsSection = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.toLowerCase() === "### available skills") {
      inAvailableSkillsSection = true;
      continue;
    }

    if (inAvailableSkillsSection && line.startsWith("### ")) {
      break;
    }

    if (!inAvailableSkillsSection) continue;

    const match = line.match(/^-\s*([^:]+):/);
    if (match) {
      const extractedName = match[1].trim();
      const canonical = knownSkillMap.get(extractedName.toLowerCase()) ?? extractedName;
      names.add(canonical);
    }
  }

  return names;
}

export function extractSkillNamesFromPathReferences(
  text: string,
  knownSkillNames?: Iterable<string>,
): Set<string> {
  const names = new Set<string>();
  if (!text) return names;

  const knownSkillMap = new Map<string, string>();
  if (knownSkillNames) {
    for (const skillName of knownSkillNames) {
      knownSkillMap.set(skillName.toLowerCase(), skillName);
    }
  }

  const patterns = [
    /(?:^|[\s"'`])(?:[^"'`\s]*?\.agents\/skills\/)([^/\s"'`]+)(?=\/)/gi,
    /(?:^|[\s"'`])(?:[^"'`\s]*?\.codex\/skills\/(?:\.system\/)?)([^/\s"'`]+)(?=\/)/gi,
    /(?:^|[\s"'`])(\/etc\/codex\/skills\/)([^/\s"'`]+)(?=\/)/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match !== null) {
      const rawName = match[2] ?? match[1];
      if (rawName) {
        const canonical = knownSkillMap.get(rawName.toLowerCase()) ?? rawName;
        if (knownSkillMap.size === 0 || knownSkillMap.has(rawName.toLowerCase())) {
          names.add(canonical);
        }
      }
      match = pattern.exec(text);
    }
  }

  return names;
}
