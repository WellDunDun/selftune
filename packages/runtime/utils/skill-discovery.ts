import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalizeSkillPackageManifest } from "@selftune/telemetry-contract";

import {
  resolveGlobalSkillPlacementDirs,
  resolveProjectSkillPlacementDirs,
} from "../vendor/skills-agent-registry.js";

export interface SkillPathMetadata {
  skill_scope: "project" | "global" | "admin" | "system" | "unknown";
  skill_project_root?: string;
  skill_registry_dir?: string;
}

export interface InstalledSkillPackage extends SkillPathMetadata {
  name: string;
  skill_path: string;
  package_path: string;
  registry_dir: string;
  modified_at: string;
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

export function getDefaultSkillSearchDirs(
  startDir: string = process.cwd(),
  homeDir: string = process.env.SELFTUNE_HOME ?? process.env.HOME ?? "",
  codexHome: string = process.env.CODEX_HOME ?? join(homeDir, ".codex"),
): string[] {
  const dirs = [
    ...resolveProjectSkillPlacementDirs(startDir),
    ...resolveGlobalSkillPlacementDirs({ homeDir, codexHome }),
    "/etc/codex/skills",
  ];
  return [...new Set(dirs.map((dir) => resolve(dir)))];
}

/** Inventory concrete installed packages without resolving away registry symlinks. */
export function findInstalledSkillPackages(
  dirs: string[],
  homeDir: string = process.env.SELFTUNE_HOME ?? process.env.HOME ?? "",
  codexHome: string = process.env.CODEX_HOME ?? join(homeDir, ".codex"),
): InstalledSkillPackage[] {
  const packages: InstalledSkillPackage[] = [];
  const seenSkillPaths = new Set<string>();

  const maybeAdd = (registryDir: string, packagePath: string, name: string): void => {
    const skillPath = join(packagePath, "SKILL.md");
    if (!existsSync(skillPath)) return;
    const normalizedSkillPath = resolve(skillPath);
    if (seenSkillPaths.has(normalizedSkillPath)) return;

    try {
      const packageStat = statSync(packagePath);
      if (!packageStat.isDirectory()) return;
      seenSkillPaths.add(normalizedSkillPath);
      packages.push({
        name,
        skill_path: normalizedSkillPath,
        package_path: resolve(packagePath),
        registry_dir: resolve(registryDir),
        modified_at: packageStat.mtime.toISOString(),
        ...classifySkillPath(normalizedSkillPath, homeDir, codexHome),
      });
    } catch {
      // Broken symlinks and unreadable packages are not actionable inventory entries.
    }
  };

  for (const inputDir of dirs) {
    const registryDir = resolve(inputDir);
    if (!existsSync(registryDir)) continue;
    try {
      for (const entry of readdirSync(registryDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const packagePath = join(registryDir, entry.name);
        if (existsSync(join(packagePath, "SKILL.md"))) {
          maybeAdd(registryDir, packagePath, entry.name);
          continue;
        }

        // Codex groups built-in skills under scopes such as .system/<skill>/SKILL.md.
        try {
          for (const nested of readdirSync(packagePath, { withFileTypes: true })) {
            if (!nested.isDirectory() && !nested.isSymbolicLink()) continue;
            maybeAdd(join(registryDir, entry.name), join(packagePath, nested.name), nested.name);
          }
        } catch {
          // Skip unreadable nested scopes.
        }
      }
    } catch {
      // Skip unreadable registries.
    }
  }

  return packages.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.skill_path.localeCompare(right.skill_path),
  );
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

function isPackageMetadataPath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  const name = segments.at(-1) ?? relativePath;
  return (
    segments.includes("__MACOSX") ||
    name === ".DS_Store" ||
    name.startsWith("._") ||
    name === "archive.tar.gz"
  );
}

function buildSkillPackageManifest(
  rootDir: string,
  base = "",
): Array<{ path: string; hash: string; size: number }> {
  const manifest: Array<{ path: string; hash: string; size: number }> = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const relativePath = base ? `${base}/${entry.name}` : entry.name;
    if (isPackageMetadataPath(relativePath)) continue;
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      manifest.push(...buildSkillPackageManifest(fullPath, relativePath));
      continue;
    }
    const fileStat = statSync(fullPath);
    if (!fileStat.isFile()) continue;
    const content = readFileSync(fullPath);
    manifest.push({
      path: relativePath,
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    });
  }
  return manifest;
}

/** Hash the complete installed skill package. Synthetic or unreadable paths stay unversioned. */
export function computeSkillVersionHash(skillPath: string): string | undefined {
  const trimmedPath = skillPath.trim();
  if (!trimmedPath || basename(trimmedPath).toUpperCase() !== "SKILL.MD") return undefined;

  try {
    const manifest = buildSkillPackageManifest(dirname(trimmedPath));
    if (!manifest.some((entry) => basename(entry.path).toUpperCase() === "SKILL.MD")) {
      return undefined;
    }
    return createHash("sha256").update(canonicalizeSkillPackageManifest(manifest)).digest("hex");
  } catch {
    return undefined;
  }
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

  const lexicalPath = resolve(trimmedPath);
  const normalizedPath = normalizePath(trimmedPath);
  const registryVariants = (root: string, ...segments: string[]): string[] =>
    root
      ? [
          ...new Set([
            resolve(join(root, ...segments)),
            resolve(join(normalizePath(root), ...segments)),
          ]),
        ]
      : [];
  const matchedRegistry = (registries: string[], path: string): string | undefined =>
    registries.find((registry) => path === registry || path.startsWith(`${registry}/`));

  const lexicalSystemRegistries = registryVariants(codexHome, "skills", ".system");
  const lexicalSystemRegistry = matchedRegistry(lexicalSystemRegistries, lexicalPath);
  if (lexicalSystemRegistry) {
    return {
      skill_scope: "system",
      skill_registry_dir:
        matchedRegistry(lexicalSystemRegistries, normalizedPath) ?? lexicalSystemRegistry,
    };
  }

  const lexicalAdminRegistry = resolve("/etc/codex/skills");
  if (lexicalPath === lexicalAdminRegistry || lexicalPath.startsWith(`${lexicalAdminRegistry}/`)) {
    return {
      skill_scope: "admin",
      skill_registry_dir: lexicalAdminRegistry,
    };
  }

  const lexicalGlobalAgentRegistries = registryVariants(homeDir, ".agents", "skills");
  const lexicalGlobalAgentRegistry = matchedRegistry(lexicalGlobalAgentRegistries, lexicalPath);
  if (lexicalGlobalAgentRegistry) {
    return {
      skill_scope: "global",
      skill_registry_dir:
        matchedRegistry(lexicalGlobalAgentRegistries, normalizedPath) ?? lexicalGlobalAgentRegistry,
    };
  }

  const lexicalGlobalClaudeRegistries = registryVariants(homeDir, ".claude", "skills");
  const lexicalGlobalClaudeRegistry = matchedRegistry(lexicalGlobalClaudeRegistries, lexicalPath);
  if (lexicalGlobalClaudeRegistry) {
    return {
      skill_scope: "global",
      skill_registry_dir:
        matchedRegistry(lexicalGlobalClaudeRegistries, normalizedPath) ??
        lexicalGlobalClaudeRegistry,
    };
  }

  const lexicalUserCodexRegistries = registryVariants(codexHome, "skills");
  const lexicalUserCodexRegistry = matchedRegistry(lexicalUserCodexRegistries, lexicalPath);
  if (lexicalUserCodexRegistry) {
    return {
      skill_scope: "global",
      skill_registry_dir:
        matchedRegistry(lexicalUserCodexRegistries, normalizedPath) ?? lexicalUserCodexRegistry,
    };
  }

  const lexicalProjectRegistries = ["/.agents/skills/", "/.claude/skills/"];
  for (const marker of lexicalProjectRegistries) {
    const markerIndex = lexicalPath.lastIndexOf(marker);
    if (markerIndex === -1) continue;
    const projectRoot = resolve(lexicalPath.slice(0, markerIndex));
    return {
      skill_scope: "project",
      skill_project_root: projectRoot,
      skill_registry_dir: `${projectRoot}${marker.slice(0, -1)}`,
    };
  }

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
    /(?:^|[\s"'`])(?:[^"'`\s]*?\.opencode\/skills\/)([^/\s"'`]+)(?=\/)/gi,
    /(?:^|[\s"'`])(?:[^"'`\s]*?\.claude\/skills\/)([^/\s"'`]+)(?=\/)/gi,
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
