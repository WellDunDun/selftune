import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { ReplayStagingMode, RoutingReplayFixture } from "../../types.js";
import { replaceDescription } from "../../utils/frontmatter.js";
import { findGitRepositoryRoot } from "../../utils/skill-discovery.js";
import { replaceBody, replaceSection } from "../deploy-proposal.js";
import type { ReplayWorkspace, RuntimeReplayContentTarget } from "./contracts.js";

export function resolveReplayPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolveObservedReplayPath(path: string, workspaceRoot: string): string {
  return resolveReplayPath(isAbsolute(path) ? path : join(workspaceRoot, path));
}

export function truncateReplayText(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function listCompetingSkillPaths(targetSkillPath: string): string[] {
  const normalizedTargetPath = resolveReplayPath(targetSkillPath);
  const targetSkillDir = dirname(normalizedTargetPath);
  const registryDir = dirname(targetSkillDir);
  const targetDirName = basename(targetSkillDir);
  const competingPaths: string[] = [];

  try {
    for (const entry of readdirSync(registryDir)) {
      if (entry === targetDirName) continue;
      const candidateDir = join(registryDir, entry);
      try {
        if (!statSync(candidateDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const candidateSkillPath = join(candidateDir, "SKILL.md");
      if (!existsSync(candidateSkillPath)) continue;
      competingPaths.push(resolveReplayPath(candidateSkillPath));
    }
  } catch {
    // Unreadable registries are treated as target-only fixtures.
  }

  return competingPaths.sort((a, b) => a.localeCompare(b));
}

function getRuntimeReplayRegistryRelativeDir(platform: RoutingReplayFixture["platform"]): string {
  switch (platform) {
    case "claude_code":
      return join(".claude", "skills");
    case "codex":
      return join(".agents", "skills");
    case "opencode":
      return join(".opencode", "skills");
  }
}

export function resolveRuntimeReplayPlatform(
  agent: string | null | undefined,
): RoutingReplayFixture["platform"] | undefined {
  if (agent === "claude") return "claude_code";
  if (agent === "codex") return "codex";
  if (agent === "opencode") return "opencode";
  return undefined;
}

export function buildRoutingReplayFixture(options: {
  skillName: string;
  skillPath: string;
  platform?: RoutingReplayFixture["platform"];
  fixtureId?: string;
  workspaceRoot?: string;
  stagingMode?: ReplayStagingMode;
}): RoutingReplayFixture {
  const targetSkillPath = resolveReplayPath(options.skillPath);
  const workspaceRoot =
    options.workspaceRoot ?? findGitRepositoryRoot(dirname(dirname(targetSkillPath)));
  const platform = options.platform ?? "claude_code";

  return {
    fixture_id: options.fixtureId ?? `auto-${platform}-${options.skillName}`,
    platform,
    target_skill_name: options.skillName,
    target_skill_path: targetSkillPath,
    competing_skill_paths: listCompetingSkillPaths(targetSkillPath),
    ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
    ...(options.stagingMode ? { skill_staging_mode: options.stagingMode } : {}),
  };
}

function buildRuntimeReplayTargetContent(
  skillPath: string,
  content: string,
  contentTarget: RuntimeReplayContentTarget,
): string {
  const currentContent = readFileSync(skillPath, "utf8");
  if (contentTarget === "body") {
    return replaceBody(currentContent, content.trim());
  }
  if (contentTarget === "description") {
    return replaceDescription(currentContent, content.trim());
  }
  return replaceSection(currentContent, "Workflow Routing", content.trim());
}

function copyDirectoryRecursive(sourceDir: string, destinationDir: string): void {
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destinationPath);
      continue;
    }
    copyFileSync(sourcePath, destinationPath);
  }
}

function stageReplaySkill(
  registryDir: string,
  sourceSkillPath: string,
  stagingMode: ReplayStagingMode,
  overrideContent?: string,
): string {
  const skillDirName = basename(dirname(sourceSkillPath)) || "unknown-skill";
  const destinationDir = join(registryDir, skillDirName);
  if (stagingMode === "package") {
    copyDirectoryRecursive(dirname(sourceSkillPath), destinationDir);
  } else {
    mkdirSync(destinationDir, { recursive: true });
  }
  const destinationPath = join(destinationDir, "SKILL.md");
  const content = overrideContent ?? readFileSync(sourceSkillPath, "utf8");
  writeFileSync(destinationPath, content, "utf8");
  return destinationPath;
}

export function buildRuntimeReplayWorkspace(
  fixture: RoutingReplayFixture,
  content: string,
  contentTarget: RuntimeReplayContentTarget,
  includeTargetSkill: boolean = true,
): ReplayWorkspace {
  const rootDir = mkdtempSync(join(tmpdir(), "selftune-runtime-replay-"));
  try {
    const registryDir = join(rootDir, getRuntimeReplayRegistryRelativeDir(fixture.platform));
    mkdirSync(join(rootDir, ".git"), { recursive: true });
    mkdirSync(registryDir, { recursive: true });
    const stagingMode = fixture.skill_staging_mode ?? "routing";
    const allowedReadRoots: string[] = [];
    const targetSkillDir = join(
      registryDir,
      basename(dirname(fixture.target_skill_path)) || "unknown-skill",
    );

    const targetSkillPath = join(targetSkillDir, "SKILL.md");
    if (includeTargetSkill) {
      const stagedTargetSkillPath = stageReplaySkill(
        registryDir,
        fixture.target_skill_path,
        stagingMode,
        buildRuntimeReplayTargetContent(fixture.target_skill_path, content, contentTarget),
      );
      allowedReadRoots.push(dirname(stagedTargetSkillPath));
    }
    const competingSkillPaths = fixture.competing_skill_paths.map((skillPath) =>
      stageReplaySkill(registryDir, skillPath, stagingMode),
    );
    for (const skillPath of competingSkillPaths) {
      allowedReadRoots.push(dirname(skillPath));
    }

    return {
      rootDir,
      skillRegistryDir: registryDir,
      targetSkillPath,
      competingSkillPaths,
      allowedReadRoots,
    };
  } catch (error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupRuntimeReplayWorkspace(workspace: ReplayWorkspace): void {
  rmSync(workspace.rootDir, { recursive: true, force: true });
}
