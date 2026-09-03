import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillSet, getSkillSet, updateSkillSet } from "@selftune/library";
import { applySkillSetLicenseDraft, previewSkillSetLicenseDraft } from "./skill-set-license-draft";

const roots: string[] = [];
const terms = {
  copyrightHolder: "Daniel Petro",
  licensedOrganization: "Ithraa Center",
  year: 2026,
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "set-license-test-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: marketing-social\ndescription: Marketing\n---\nContent\n",
  );
  writeFileSync(join(source, "asset.txt"), "preserve the Studio assets");
  const options = { configRoot: join(root, "config") };
  const set = createSkillSet(
    {
      name: "Ithraa",
      harnesses: ["codex"],
      skills: [{ name: "marketing-social", package_path: source }],
    },
    options,
  );
  return { set, options };
}

test("drafts an imported package without installation and saves a new immutable revision", () => {
  const { set, options } = fixture();
  const original = set.skills[0]!;
  const before = readFileSync(join(original.library_package_path, "SKILL.md"), "utf8");
  const preview = previewSkillSetLicenseDraft(set.set_id, original.name, terms, options);
  expect(existsSync(join(original.library_package_path, "LICENSE"))).toBe(false);
  applySkillSetLicenseDraft(set.set_id, original.name, preview.previewId, terms, options);
  const next = getSkillSet(set.set_id, options);
  expect(next.revision).toBe(2);
  expect(next.parent_revision_hash).toBe(set.revision_hash);
  expect(next.skills[0]!.content_hash).not.toBe(original.content_hash);
  expect(readFileSync(join(original.library_package_path, "SKILL.md"), "utf8")).toBe(before);
  expect(existsSync(join(original.library_package_path, "LICENSE"))).toBe(false);
  expect(readFileSync(join(next.skills[0]!.library_package_path, "LICENSE"), "utf8")).toContain(
    "Ithraa Center",
  );
  expect(readFileSync(join(next.skills[0]!.library_package_path, "asset.txt"), "utf8")).toBe(
    "preserve the Studio assets",
  );
});

test("rejects changed terms, changed revisions, and skills outside the Set", () => {
  const { set, options } = fixture();
  const skill = set.skills[0]!;
  const preview = previewSkillSetLicenseDraft(set.set_id, skill.name, terms, options);
  expect(() =>
    applySkillSetLicenseDraft(
      set.set_id,
      skill.name,
      preview.previewId,
      { ...terms, year: 2027 },
      options,
    ),
  ).toThrow("Review the draft again");
  expect(() => previewSkillSetLicenseDraft(set.set_id, "other", terms, options)).toThrow(
    "no longer in the Skill Set",
  );
  updateSkillSet(
    set.set_id,
    {
      name: "Changed",
      harnesses: set.harnesses,
      skills: [{ name: skill.name, package_path: skill.library_package_path }],
    },
    options,
  );
  expect(() =>
    applySkillSetLicenseDraft(set.set_id, skill.name, preview.previewId, terms, options),
  ).toThrow("Review the draft again");
  expect(existsSync(join(skill.library_package_path, "LICENSE"))).toBe(false);
});
