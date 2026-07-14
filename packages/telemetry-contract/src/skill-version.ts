export interface SkillPackageManifestEntry {
  path: string;
  hash: string;
  size: number;
}

function normalizeManifestPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function compareManifestPaths(left: { path: string }, right: { path: string }): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/** Stable byte input for a SHA-256 identity of the complete executable skill package. */
export function canonicalizeSkillPackageManifest(
  entries: readonly SkillPackageManifestEntry[],
): string {
  return JSON.stringify(
    entries
      .map((entry) => ({
        path: normalizeManifestPath(entry.path),
        hash: entry.hash.toLowerCase(),
        size: entry.size,
      }))
      .sort(compareManifestPaths),
  );
}
