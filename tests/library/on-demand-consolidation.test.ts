import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
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
import { quarantinePortfolioBatch } from "../../packages/runtime/skill-portfolio/on-demand-batch.js";
import { restoreQuarantinedSkill } from "../../packages/runtime/skill-portfolio/quarantine.js";
import {
  computeSkillVersionHash,
  findInstalledSkillPackages,
} from "../../packages/runtime/utils/skill-discovery.js";
import { loadLibraryCatalog } from "../../packages/runtime/library-catalog.js";
import { searchLocalSkills } from "../../packages/runtime/skill-search/search.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "on-demand-consolidate-"));
  roots.push(root);
  const dirs = [
    join(root, ".claude/skills"),
    join(root, ".agents/skills"),
    join(root, ".pi/skills"),
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const source = join(dirs[0]!, "marketing");
  mkdirSync(source);
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: marketing\ndescription: Marketing launches\n---\nLong body does not count as discovery.\n",
  );
  cpSync(source, join(dirs[1]!, "marketing"), { recursive: true });
  symlinkSync(source, join(dirs[2]!, "marketing"));
  const installedSkills = findInstalledSkillPackages(dirs);
  const options = {
    installedSkills,
    configRoot: join(root, "config"),
    quarantineRoot: join(root, "config/quarantine"),
  };
  const inputs = installedSkills.map((skill) => ({
    skillName: skill.name,
    skillPath: skill.skill_path,
    expectedContentHash: computeSkillVersionHash(skill.skill_path),
    keepSearchable: true,
  }));
  return { root, dirs, source, options, inputs };
}
test("consolidates identical copies and links to one searchable revision, with complete undo", async () => {
  const f = fixture();
  const moved = quarantinePortfolioBatch(f.inputs, f.options);
  expect(moved.failures).toEqual([]);
  expect(moved.receipts).toHaveLength(3);
  expect(f.inputs.every((input) => !existsSync(input.skillPath))).toBe(true);
  const search = searchLocalSkills({
    query: "marketing",
    configRoot: f.options.configRoot,
    searchDirs: f.dirs,
  });
  expect(search.results).toHaveLength(1);
  const catalog = await loadLibraryCatalog({
    searchDirs: f.dirs,
    skillSetConfigRoot: f.options.configRoot,
    quarantineRoot: f.options.quarantineRoot,
    usageRows: [],
  });
  const skill = catalog.skills.find((item) => item.name === "marketing")!;
  expect(skill.revisions).toHaveLength(1);
  expect(
    skill.locations
      .filter((location) => location.sourceKind === "archived")
      .every((location) => location.discovery?.description === "Marketing launches"),
  ).toBe(true);
  for (const receipt of moved.receipts)
    restoreQuarantinedSkill({
      quarantineId: receipt.quarantine_id,
      quarantineRoot: f.options.quarantineRoot,
    });
  expect(
    f.inputs.every((input) => readFileSync(input.skillPath, "utf8").includes("Marketing launches")),
  ).toBe(true);
});
test("blocks all copies before mutation when a reviewed source changes or a new copy appears", () => {
  const f = fixture();
  writeFileSync(join(f.source, "SKILL.md"), "Changed");
  const result = quarantinePortfolioBatch(f.inputs, f.options);
  expect(result.receipts).toHaveLength(0);
  expect(result.failures).toHaveLength(3);
  expect(f.inputs.every((input) => existsSync(input.skillPath))).toBe(true);
  expect(quarantinePortfolioBatch(f.inputs.slice(0, 1), f.options).receipts).toHaveLength(0);
});
