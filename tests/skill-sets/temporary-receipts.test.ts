import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySkillManifest,
  createSkillSet,
  listSkillSetReceipts,
  listSkillSets,
  planSkillManifest,
  planSkillSetRollback,
  rollbackSkillSet,
} from "@selftune/library";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "selftune-temporary-receipts-")));
  roots.push(root);
  const project = join(root, "project");
  const source = join(root, "copywriting");
  mkdirSync(project);
  mkdirSync(source);
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: copywriting\ndescription: Marketing copy\n---\nUse concise language.",
  );
  const options = { configRoot: join(root, "config") };
  const manifest = createSkillSet(
    {
      name: "Marketing",
      harnesses: ["codex"],
      skills: [{ name: "copywriting", package_path: source }],
    },
    options,
  );
  return {
    root,
    project,
    source,
    options,
    manifest,
    target: join(project, ".agents", "skills", "copywriting"),
  };
}
test("in-memory selection uses existing receipts, no extra Set, and idempotent cleanup", () => {
  const { manifest, options, project, target } = fixture();
  expect(planSkillManifest({ project_root: project }, manifest).creates).toBe(1);
  const receipt = applySkillManifest(
    { project_root: project, temporary_task: "task-a" },
    manifest,
    options,
  );
  expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("concise");
  expect(listSkillSets(options)).toHaveLength(1);
  expect(listSkillSetReceipts(options)[0]?.temporary_task).toBe("task-a");
  expect(planSkillSetRollback(receipt.receipt_id, options).paths).toEqual([target]);
  rollbackSkillSet(receipt.receipt_id, options);
  expect(existsSync(target)).toBe(false);
  expect(rollbackSkillSet(receipt.receipt_id, options).status).toBe("rolled_back");
});
test("overlapping task cannot borrow links and its failed reservation owns nothing", () => {
  const { manifest, options, project, target } = fixture();
  const first = applySkillManifest(
    { project_root: project, temporary_task: "task-a" },
    manifest,
    options,
  );
  expect(() =>
    applySkillManifest({ project_root: project, temporary_task: "task-b" }, manifest, options),
  ).toThrow("reserved by task");
  expect(existsSync(target)).toBe(true);
  expect(
    listSkillSetReceipts(options).filter((item) => item.status !== "rolled_back"),
  ).toHaveLength(1);
  rollbackSkillSet(first.receipt_id, options);
});
test("temporary cleanup preserves pre-existing skills and handles already-removed links", () => {
  const { manifest, options, project, target, source } = fixture();
  mkdirSync(join(project, ".agents", "skills"), { recursive: true });
  symlinkSync(source, target);
  const existing = applySkillManifest(
    { project_root: project, temporary_task: "task-a" },
    manifest,
    options,
  );
  expect(existing.operations).toEqual([]);
  rollbackSkillSet(existing.receipt_id, options);
  expect(existsSync(target)).toBe(true);
  rmSync(target);
  const owned = applySkillManifest(
    { project_root: project, temporary_task: "task-a" },
    manifest,
    options,
  );
  rmSync(target);
  expect(rollbackSkillSet(owned.receipt_id, options).status).toBe("rolled_back");
});
test("cleanup blocks a replaced target or redirected registry", () => {
  const { manifest, options, project, target, source, root } = fixture();
  const receipt = applySkillManifest(
    { project_root: project, temporary_task: "task-a" },
    manifest,
    options,
  );
  rmSync(target);
  symlinkSync(source, target);
  expect(() => rollbackSkillSet(receipt.receipt_id, options)).toThrow("replaced");
  const outside = join(root, "outside");
  mkdirSync(outside);
  rmSync(join(project, ".agents"), { recursive: true });
  symlinkSync(outside, join(project, ".agents"));
  expect(() => rollbackSkillSet(receipt.receipt_id, options)).toThrow("outside");
});
test("an interrupted mutation without an ownership identity never deletes an existing target", () => {
  const { manifest, options, project, target } = fixture();
  const receipt = applySkillManifest(
    { project_root: project, temporary_task: "task-a" },
    manifest,
    options,
  );
  writeFileSync(
    join(options.configRoot, "skill-set-receipts", `${receipt.receipt_id}.json`),
    JSON.stringify({
      ...receipt,
      status: "applying",
      operations: receipt.operations.map((operation) => ({
        harness: operation.harness,
        skill_name: operation.skill_name,
        content_hash: operation.content_hash,
        source_path: operation.source_path,
        target_path: operation.target_path,
        state: "pending",
        strategy: null,
      })),
    }),
  );
  expect(() => rollbackSkillSet(receipt.receipt_id, options)).toThrow("unverified");
  expect(existsSync(target)).toBe(true);
});
