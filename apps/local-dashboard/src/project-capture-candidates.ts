import type { ProjectCaptureCandidateModel } from "@selftune/dashboard-core/models";

import type { LibrarySnapshot } from "./types";

function projectName(projectRoot: string): string {
  const folder = projectRoot.match(/[^\\/]+$/)?.[0] ?? projectRoot;
  return folder
    .replace(/[-_.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function isCaptureEligibleProjectRoot(projectRoot: string): boolean {
  const normalized = projectRoot.replaceAll("\\", "/");
  return (
    !normalized.startsWith("/tmp/") &&
    !normalized.startsWith("/private/tmp/") &&
    !normalized.includes("/.claude/worktrees/") &&
    !normalized.includes("/.codex/worktrees/")
  );
}

export function projectCaptureCandidatesFromLibrary(
  library: LibrarySnapshot,
): ProjectCaptureCandidateModel[] {
  const projects = new Map<
    string,
    {
      connections: Set<ProjectCaptureCandidateModel["connections"][number]>;
      skills: Set<string>;
      lastUsedAt: string | null;
    }
  >();
  for (const skill of library.skills) {
    for (const location of skill.locations) {
      if (
        !location.active ||
        location.sourceKind !== "installed" ||
        location.scope !== "project" ||
        !location.projectRoot ||
        !isCaptureEligibleProjectRoot(location.projectRoot) ||
        !location.harness
      ) {
        continue;
      }
      const project = projects.get(location.projectRoot) ?? {
        connections: new Set(),
        skills: new Set(),
        lastUsedAt: null,
      };
      project.connections.add(location.harness);
      project.skills.add(skill.name);
      if (
        location.lastUsedAt &&
        (!project.lastUsedAt || location.lastUsedAt > project.lastUsedAt)
      ) {
        project.lastUsedAt = location.lastUsedAt;
      }
      projects.set(location.projectRoot, project);
    }
  }
  return [...projects.entries()]
    .map(([projectRoot, project]) => ({
      projectRoot,
      name: projectName(projectRoot),
      connections: [...project.connections].toSorted(),
      skillCount: project.skills.size,
      lastUsedAt: project.lastUsedAt,
    }))
    .toSorted(
      (left, right) =>
        (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "") ||
        left.name.localeCompare(right.name),
    );
}
