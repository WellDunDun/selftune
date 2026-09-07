import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";

import { findSelftunePackageRoot } from "./package-root.js";

const MANIFEST_FILENAME = ".selftune-manifest.json";

const LEGACY_SELFTUNE_AGENT_FILES = [
  "diagnosis-analyst.md",
  "evolution-reviewer.md",
  "integration-guide.md",
  "pattern-analyst.md",
] as const;

const BUNDLED_AGENT_DIR = join(findSelftunePackageRoot(), "skill", "agents");

const AgentManifest = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.mutable(Schema.Array(Schema.String.check(Schema.isPattern(/^[^/\\\0:]+\.md$/)))),
  synced_at: Schema.String,
});
type AgentManifest = typeof AgentManifest.Type;

function readManifest(path: string): AgentManifest | null {
  try {
    if (!existsSync(path)) return null;
    return Schema.decodeUnknownSync(Schema.fromJsonString(AgentManifest))(
      readFileSync(path, "utf-8"),
    );
  } catch {
    return null;
  }
}

function writeManifest(path: string, files: string[]): void {
  const manifest: AgentManifest = {
    version: 1,
    files: files.toSorted(),
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
      .toSorted();
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
  return [...changed].toSorted();
}

export function checkAgentFiles(options?: { homeDir?: string; sourceDir?: string }): boolean {
  const homeDir = options?.homeDir ?? homedir();
  const sourceDir = options?.sourceDir ?? BUNDLED_AGENT_DIR;
  const sourceFiles = listBundledAgentFiles(sourceDir);
  if (sourceFiles.length === 0) return false;

  const manifest = readManifest(getClaudeAgentManifestPath(homeDir));
  if (!manifest || manifest.files.length !== sourceFiles.length) return false;
  if (manifest.files.some((fileName, index) => fileName !== sourceFiles[index])) return false;

  const targetDir = getClaudeAgentsDir(homeDir);
  return sourceFiles.every(
    (fileName) =>
      readTextIfExists(join(sourceDir, fileName)) === readTextIfExists(join(targetDir, fileName)),
  );
}

export function removeInstalledAgentFiles(options?: { homeDir?: string; dryRun?: boolean }) {
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
