import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { canonicalizeSkillPackageManifest } from "@selftune/telemetry-contract";

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
  contentOverrides: ReadonlyMap<string, Uint8Array> = new Map(),
): Array<{ path: string; hash: string; size: number }> {
  const manifest: Array<{ path: string; hash: string; size: number }> = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const relativePath = base ? `${base}/${entry.name}` : entry.name;
    if (isPackageMetadataPath(relativePath)) continue;
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      manifest.push(...buildSkillPackageManifest(fullPath, relativePath, contentOverrides));
      continue;
    }
    const fileStat = statSync(fullPath);
    if (!fileStat.isFile()) continue;
    const content = contentOverrides.get(fullPath) ?? readFileSync(fullPath);
    manifest.push({
      path: relativePath,
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    });
  }
  return manifest;
}

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

/**
 * Computes the exact package revision that would result from replacing only
 * SKILL.md content. The package is never copied or mutated, so candidate
 * evaluation can pin the same revision a later reviewed deployment will
 * produce while scripts and supporting files remain part of the hash.
 */
export function computeSkillVersionHashWithContent(
  skillPath: string,
  skillContent: string,
): string | undefined {
  const trimmedPath = skillPath.trim();
  if (!trimmedPath || basename(trimmedPath).toUpperCase() !== "SKILL.MD") return undefined;

  try {
    const content = new TextEncoder().encode(skillContent);
    const manifest = buildSkillPackageManifest(
      dirname(trimmedPath),
      "",
      new Map([[trimmedPath, content]]),
    );
    if (!manifest.some((entry) => basename(entry.path).toUpperCase() === "SKILL.MD")) {
      return undefined;
    }
    return createHash("sha256").update(canonicalizeSkillPackageManifest(manifest)).digest("hex");
  } catch {
    return undefined;
  }
}
