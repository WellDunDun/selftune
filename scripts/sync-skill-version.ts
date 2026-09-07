#!/usr/bin/env bun
/**
 * Stamps skill/SKILL.md frontmatter version to match package.json.
 * Run automatically via `bun run sync-version` or during prepublishOnly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
let pkgVersion: string;
try {
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  // SAFETY-TYPEOF: This script runs before dependency installation in fresh export clones, so it
  // validates the dependency-free JSON boundary directly before using the package version.
  if (
    typeof pkg !== "object" ||
    pkg === null ||
    !("version" in pkg) ||
    typeof pkg.version !== "string" ||
    pkg.version.trim().length === 0
  ) {
    throw new Error("invalid package version");
  }
  pkgVersion = pkg.version;
} catch {
  console.error("ERROR: package.json `version` must be a non-empty string");
  process.exit(1);
}

const skillPath = join(root, "skill", "SKILL.md");
const content = readFileSync(skillPath, "utf-8");

const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
const frontmatterMatch = content.match(frontmatterRegex);
if (!frontmatterMatch) {
  console.error(`ERROR: No YAML frontmatter found in ${skillPath}`);
  process.exit(1);
}

const frontmatter = frontmatterMatch[1];
const versionRegex = /^(\s*version:\s*).+$/m;
if (!versionRegex.test(frontmatter)) {
  console.error(`ERROR: No version frontmatter found in ${skillPath}`);
  process.exit(1);
}

const updatedFrontmatter = frontmatter.replace(versionRegex, `$1${pkgVersion}`);
const updated = content.replace(frontmatterRegex, `---\n${updatedFrontmatter}\n---`);

if (content === updated) {
  console.log(`skill/SKILL.md already at v${pkgVersion}`);
} else {
  writeFileSync(skillPath, updated);
  console.log(`skill/SKILL.md version updated to v${pkgVersion}`);
}
