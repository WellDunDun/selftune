import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSkillVersionHash } from "@selftune/library/hash";
import {
  quarantineSkill,
  restoreQuarantinedSkill,
} from "../../packages/runtime/skill-portfolio/quarantine.js";
import { findInstalledSkillPackages } from "../../packages/runtime/utils/skill-discovery.js";
import { searchLocalSkills } from "../../packages/runtime/skill-search/search.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-on-demand-"));
  roots.push(root);
  const registry = join(root, ".agents", "skills");
  const packagePath = join(registry, "marketing");
  const skillPath = join(packagePath, "SKILL.md");
  const configRoot = join(root, "config");
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    skillPath,
    "---\nname: marketing\ndescription: Marketing copywriting\n---\nDraft useful copy.\n",
  );
  writeFileSync(join(packagePath, "reference.md"), "Preserve this reference.\n");
  return {
    root,
    registry,
    packagePath,
    skillPath,
    configRoot,
    quarantineRoot: join(configRoot, "quarantine"),
  };
}
function options(f: ReturnType<typeof fixture>) {
  return {
    installedSkills: findInstalledSkillPackages([f.registry]),
    skillName: "marketing",
    skillPath: f.skillPath,
    configRoot: f.configRoot,
    quarantineRoot: f.quarantineRoot,
    keepSearchable: true,
    expectedPackageVersionHash: computeSkillVersionHash(f.skillPath),
  };
}

test("review is read-only and a changed package is blocked before caching or removal", () => {
  const f = fixture();
  const reviewed = options(f);
  quarantineSkill({ ...reviewed, dryRun: true });
  expect(existsSync(f.configRoot)).toBe(false);
  writeFileSync(join(f.packagePath, "reference.md"), "Changed after review");
  expect(() => quarantineSkill(reviewed)).toThrow("changed after removal review");
  expect(existsSync(f.skillPath)).toBe(true);
  expect(existsSync(f.configRoot)).toBe(false);
});

test("a missing reviewed revision cannot move an on-demand skill", () => {
  const f = fixture();
  expect(() => quarantineSkill({ ...options(f), expectedPackageVersionHash: undefined })).toThrow(
    "Review the skill revision",
  );
  expect(existsSync(f.skillPath)).toBe(true);
});

test("retries preserve the receipt and require the verified Library copy", () => {
  const f = fixture();
  const reviewed = options(f);
  const receipt = quarantineSkill(reviewed);
  const retry = { ...reviewed, installedSkills: [] };
  expect(quarantineSkill(retry).quarantine_id).toBe(receipt.quarantine_id);
  const hit = searchLocalSkills({
    query: "marketing",
    configRoot: f.configRoot,
    searchDirs: [f.registry],
  }).results[0]!;
  writeFileSync(hit.skill_path, "corrupted copy");
  expect(() => quarantineSkill(retry)).toThrow("no verified searchable Library copy");
});

test("ordinary quarantine cannot be mistaken for a searchable move on retry", () => {
  const f = fixture();
  const reviewed = options(f);
  quarantineSkill({ ...reviewed, keepSearchable: false });
  expect(() => quarantineSkill({ ...reviewed, installedSkills: [] })).toThrow(
    "no verified searchable Library copy",
  );
});

test("a symlinked installation remains searchable and undo restores the link without overwriting conflicts", () => {
  const f = fixture();
  const source = join(f.root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), readFileSync(f.skillPath));
  rmSync(f.packagePath, { recursive: true });
  symlinkSync(source, f.packagePath, "dir");
  const receipt = quarantineSkill(options(f));
  expect(existsSync(f.packagePath)).toBe(false);
  expect(existsSync(join(source, "SKILL.md"))).toBe(true);
  const hit = searchLocalSkills({
    query: "copywriting",
    configRoot: f.configRoot,
    searchDirs: [f.registry],
  }).results[0]!;
  expect(hit.name).toBe("marketing");
  mkdirSync(f.packagePath);
  expect(() =>
    restoreQuarantinedSkill({
      quarantineId: receipt.quarantine_id,
      quarantineRoot: f.quarantineRoot,
    }),
  ).toThrow("already exists");
  rmSync(f.packagePath, { recursive: true });
  restoreQuarantinedSkill({
    quarantineId: receipt.quarantine_id,
    quarantineRoot: f.quarantineRoot,
  });
  expect(readFileSync(f.skillPath, "utf8")).toContain("Draft useful copy");
  expect(existsSync(hit.skill_path)).toBe(true);
});
