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
