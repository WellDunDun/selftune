import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { LibraryError as CLIError } from "./errors.js";
import { computeSkillVersionHash } from "./hash.js";
import { getSkillSet } from "./manifests.js";
import { targetRegistryPath } from "./paths.js";
import { entryExists } from "./storage.js";
import type {
  SkillSetPlan,
  SkillSetPlanAction,
  SkillSetPlanOperation,
  SkillSetServiceOptions,
} from "./types.js";

export function resolvesToSource(targetPath: string, sourcePath: string): boolean {
  try {
    const link = readlinkSync(targetPath);
    return resolve(dirname(targetPath), link) === resolve(sourcePath);
  } catch {
    return false;
  }
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

export function assertProjectTargetContained(projectRoot: string, targetPath: string): void {
  if (!isContainedPath(projectRoot, targetPath)) {
    throw new CLIError(`Skill Set target escapes the project root: ${targetPath}`, "GUARD_BLOCKED");
  }

  let existingAncestor = dirname(targetPath);
  while (!entryExists(existingAncestor) && existingAncestor !== projectRoot) {
    existingAncestor = dirname(existingAncestor);
  }
  let resolvedAncestor: string;
  try {
    resolvedAncestor = realpathSync(existingAncestor);
  } catch {
    throw new CLIError(
      `Skill Set target has an unreadable or broken ancestor: ${existingAncestor}`,
      "GUARD_BLOCKED",
    );
  }
  if (!isContainedPath(projectRoot, resolvedAncestor)) {
    throw new CLIError(
      `Skill Set target is redirected outside the project: ${existingAncestor}`,
      "GUARD_BLOCKED",
      "Replace the external registry link or choose a different project.",
    );
  }
}

export function planSkillSet(
  input: { set_id: string; project_root: string; harnesses?: ReadonlyArray<string> },
  options: SkillSetServiceOptions = {},
): SkillSetPlan {
  if (!input || typeof input.set_id !== "string" || !input.set_id.trim()) {
    throw new CLIError("Skill Set ID is required.", "MISSING_FLAG");
  }
  if (typeof input.project_root !== "string" || !input.project_root.trim()) {
    throw new CLIError("Project root is required.", "MISSING_FLAG");
  }
  const manifest = getSkillSet(input.set_id.trim(), options);
  const requestedProjectRoot = resolve(input.project_root.trim());
  if (!existsSync(requestedProjectRoot) || !statSync(requestedProjectRoot).isDirectory()) {
    throw new CLIError(
      `Project directory was not found: ${requestedProjectRoot}`,
      "FILE_NOT_FOUND",
    );
  }
  const projectRoot = realpathSync(requestedProjectRoot);
  const operations: SkillSetPlanOperation[] = [];

  const targetHarnesses = input.harnesses
    ? manifest.harnesses.filter((harness) => input.harnesses!.includes(harness))
    : manifest.harnesses;
  for (const harness of targetHarnesses) {
    const registryPath = targetRegistryPath(projectRoot, harness);
    for (const skill of manifest.skills) {
      const targetPath = join(registryPath, skill.name);
      assertProjectTargetContained(projectRoot, targetPath);
      let action: SkillSetPlanAction = "create";
      let reason = "The pinned Library revision will be linked into this project.";
      if (entryExists(targetPath)) {
        const existingHash = computeSkillVersionHash(join(targetPath, "SKILL.md"));
        if (existingHash === skill.content_hash) {
          action = "unchanged";
          reason = "The project already contains the pinned revision.";
        } else if (
          !existsSync(join(skill.library_package_path, "SKILL.md")) &&
          resolvesToSource(targetPath, skill.library_package_path)
        ) {
          action = "unchanged";
          reason = "The project link is correct; its missing Library revision will be downloaded.";
        } else {
          action = "conflict";
          reason = "The destination contains a different package revision.";
        }
      }
      operations.push({
        harness,
        skill_name: skill.name,
        content_hash: skill.content_hash,
        source_path: skill.library_package_path,
        target_path: targetPath,
        action,
        reason,
      });
    }
  }

  return {
    set_id: manifest.set_id,
    set_name: manifest.name,
    set_revision_hash: manifest.revision_hash,
    project_root: projectRoot,
    operations,
    creates: operations.filter((operation) => operation.action === "create").length,
    unchanged: operations.filter((operation) => operation.action === "unchanged").length,
    conflicts: operations.filter((operation) => operation.action === "conflict").length,
    missing_dependencies: manifest.skills.filter(
      (skill) => !existsSync(join(skill.library_package_path, "SKILL.md")),
    ).length,
  };
}
