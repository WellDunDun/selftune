#!/usr/bin/env bun
/**
 * Stamps skill/SKILL.md frontmatter version to match package.json.
 * Run automatically via `bun run sync-version` or during prepublishOnly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkgVersion: string = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;

const skillPath = join(root, "skill", "SKILL.md");
const content = readFileSync(skillPath, "utf-8");

const versionRegex = /^(\s*version:\s*).+$/m;
if (!versionRegex.test(content)) {
  console.error(`ERROR: No version frontmatter found in ${skillPath}`);
  process.exit(1);
}

const updated = content.replace(versionRegex, `$1${pkgVersion}`);

if (content === updated) {
  console.log(`skill/SKILL.md already at v${pkgVersion}`);
} else {
  writeFileSync(skillPath, updated);
  console.log(`skill/SKILL.md version updated to v${pkgVersion}`);
}
