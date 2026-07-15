import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { buildCreateSkillManifest, type CreateSkillManifest } from "./templates.js";

function resolveDraftSkillPaths(
  skillPathArg: string,
): { skillDir: string; skillPath: string } | null {
  const trimmed = skillPathArg.trim();
  if (!trimmed) return null;

  const absolute = resolve(trimmed);
  if (!existsSync(absolute)) return null;

  const stat = statSync(absolute);
  if (stat.isDirectory()) {
    const skillPath = join(absolute, "SKILL.md");
    return existsSync(skillPath) ? { skillDir: absolute, skillPath } : null;
  }

  return { skillDir: dirname(absolute), skillPath: absolute };
}

function loadDraftManifest(skillDir: string): { manifest: CreateSkillManifest; present: boolean } {
  const manifestPath = join(skillDir, "selftune.create.json");
  const fallback = buildCreateSkillManifest();

  if (!existsSync(manifestPath)) {
    return { manifest: fallback, present: false };
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<CreateSkillManifest>;
    return {
      manifest: {
        version: 1,
        entry_workflow:
          typeof parsed.entry_workflow === "string" && parsed.entry_workflow.trim().length > 0
            ? parsed.entry_workflow
            : fallback.entry_workflow,
        supports_package_replay:
          typeof parsed.supports_package_replay === "boolean"
            ? parsed.supports_package_replay
            : fallback.supports_package_replay,
        expected_resources: {
          workflows:
            typeof parsed.expected_resources?.workflows === "boolean"
              ? parsed.expected_resources.workflows
              : fallback.expected_resources.workflows,
          references:
            typeof parsed.expected_resources?.references === "boolean"
              ? parsed.expected_resources.references
              : fallback.expected_resources.references,
          scripts:
            typeof parsed.expected_resources?.scripts === "boolean"
              ? parsed.expected_resources.scripts
              : fallback.expected_resources.scripts,
          assets:
            typeof parsed.expected_resources?.assets === "boolean"
              ? parsed.expected_resources.assets
              : fallback.expected_resources.assets,
        },
      },
      present: true,
    };
  } catch {
    return { manifest: fallback, present: false };
  }
}

function collectFiles(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];

  const discovered: string[] = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      discovered.push(...collectFiles(root, absolute));
    } else if (stat.isFile()) {
      discovered.push(relative(root, absolute));
    }
  }

  return discovered;
}

export function computeCreatePackageFingerprint(skillPathArg: string): string | null {
  const resolvedPaths = resolveDraftSkillPaths(skillPathArg);
  if (!resolvedPaths) return null;

  const { skillDir, skillPath } = resolvedPaths;
  const { manifest, present: manifestPresent } = loadDraftManifest(skillDir);

  const trackedPaths = new Set<string>(["SKILL.md"]);
  if (manifestPresent) {
    trackedPaths.add("selftune.create.json");
  }

  if (manifest.entry_workflow.trim().length > 0) {
    trackedPaths.add(manifest.entry_workflow);
  }

  if (manifest.expected_resources.workflows) {
    for (const entry of collectFiles(skillDir, join(skillDir, "workflows"))) {
      trackedPaths.add(entry);
    }
  }
  if (manifest.expected_resources.references) {
    for (const entry of collectFiles(skillDir, join(skillDir, "references"))) {
      trackedPaths.add(entry);
    }
  }
  if (manifest.expected_resources.scripts) {
    for (const entry of collectFiles(skillDir, join(skillDir, "scripts"))) {
      trackedPaths.add(entry);
    }
  }
  if (manifest.expected_resources.assets) {
    for (const entry of collectFiles(skillDir, join(skillDir, "assets"))) {
      trackedPaths.add(entry);
    }
  }

  const hasher = createHash("sha256");
  hasher.update("selftune:create-package:v1\0");
  hasher.update(`${relative(skillDir, skillPath) || "SKILL.md"}\0`);

  for (const relativePath of [...trackedPaths].toSorted()) {
    const absolutePath = join(skillDir, relativePath);
    if (!existsSync(absolutePath)) continue;
    const stat = statSync(absolutePath);
    if (!stat.isFile()) continue;
    hasher.update(relativePath);
    hasher.update("\0");
    hasher.update(readFileSync(absolutePath));
    hasher.update("\0");
  }

  return `pkg_sha256_${hasher.digest("hex").slice(0, 16)}`;
}
