import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MANIFEST_FILENAME = ".selftune-manifest.json";

const LEGACY_SELFTUNE_AGENT_FILES = [
  "diagnosis-analyst.md",
  "evolution-reviewer.md",
  "integration-guide.md",
  "pattern-analyst.md",
] as const;

const BUNDLED_AGENT_DIR = resolve(dirname(import.meta.path), "..", "..", "skill", "agents");

interface AgentManifest {
  version: 1;
  files: string[];
  synced_at: string;
}

function readManifest(path: string): AgentManifest | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentManifest>;
    if (!Array.isArray(parsed.files)) return null;
    return {
      version: 1,
      files: parsed.files.filter((name): name is string => typeof name === "string"),
      synced_at: typeof parsed.synced_at === "string" ? parsed.synced_at : "",
    };
  } catch {
    return null;
  }
}

function writeManifest(path: string, files: string[]): void {
  const manifest: AgentManifest = {
    version: 1,
    files: [...files].sort(),
    synced_at: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}

function readTextIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function getClaudeAgentsDir(homeDir = homedir()): string {
  return join(homeDir, ".claude", "agents");
}

export function getClaudeAgentManifestPath(homeDir = homedir()): string {
  return join(getClaudeAgentsDir(homeDir), MANIFEST_FILENAME);
}

export function listBundledAgentFiles(sourceDir = BUNDLED_AGENT_DIR): string[] {
  try {
    if (!existsSync(sourceDir)) return [];
    return readdirSync(sourceDir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

export function installAgentFiles(options?: {
  homeDir?: string;
  force?: boolean;
  sourceDir?: string;
}): string[] {
  const homeDir = options?.homeDir ?? homedir();
  const targetDir = getClaudeAgentsDir(homeDir);
  const manifestPath = getClaudeAgentManifestPath(homeDir);
  const sourceDir = options?.sourceDir ?? BUNDLED_AGENT_DIR;
  const sourceFiles = listBundledAgentFiles(sourceDir);
  if (sourceFiles.length === 0) return [];

  mkdirSync(targetDir, { recursive: true });

  const manifest = readManifest(manifestPath);
  const managedFiles = new Set<string>([
    ...LEGACY_SELFTUNE_AGENT_FILES,
    ...(manifest?.files ?? []),
  ]);
  const sourceSet = new Set(sourceFiles);
  const changed = new Set<string>();

  for (const staleFile of managedFiles) {
    if (sourceSet.has(staleFile)) continue;
    const stalePath = join(targetDir, staleFile);
    if (existsSync(stalePath)) {
      rmSync(stalePath, { force: true });
      changed.add(staleFile);
    }
  }

  for (const fileName of sourceFiles) {
    const sourcePath = join(sourceDir, fileName);
    const targetPath = join(targetDir, fileName);
    const sourceContent = readTextIfExists(sourcePath);
    if (sourceContent === null) continue;
    const existingContent = readTextIfExists(targetPath);

    if (options?.force || existingContent !== sourceContent) {
      writeFileSync(targetPath, sourceContent, "utf-8");
      changed.add(fileName);
    }
  }

  writeManifest(manifestPath, sourceFiles);
  return [...changed].sort();
}

export function removeInstalledAgentFiles(options?: { homeDir?: string; dryRun?: boolean }): {
  removed: number;
  files: string[];
} {
  const homeDir = options?.homeDir ?? homedir();
  const targetDir = getClaudeAgentsDir(homeDir);
  const manifestPath = getClaudeAgentManifestPath(homeDir);
  const manifest = readManifest(manifestPath);
  const managedFiles = new Set<string>([
    ...LEGACY_SELFTUNE_AGENT_FILES,
    ...listBundledAgentFiles(),
    ...(manifest?.files ?? []),
  ]);
  const removed: string[] = [];

  for (const fileName of managedFiles) {
    const targetPath = join(targetDir, fileName);
    if (!existsSync(targetPath)) continue;
    if (!options?.dryRun) {
      rmSync(targetPath, { force: true });
    }
    removed.push(targetPath);
  }

  if (existsSync(manifestPath)) {
    if (!options?.dryRun) {
      rmSync(manifestPath, { force: true });
    }
    removed.push(manifestPath);
  }

  return { removed: removed.length, files: removed };
}
