import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSkillSet, listSkillSets } from "@selftune/library";
import {
  activateSkills,
  type ActivationOptions,
  activeSkills,
  deactivateSkills,
  loadSkill,
  previewActivation,
  previewDeactivation,
} from "../../packages/runtime/skill-search/activation.js";
import { searchLocalSkills } from "../../packages/runtime/skill-search/search.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "selftune-activation-")));
  roots.push(root);
  const configRoot = join(root, "config");
  const project = join(root, "project");
  mkdirSync(project);
  const source = join(root, "source");
  mkdirSync(source);
  const packages = ["copywriting", "email"].map((name) => {
    const path = join(source, name);
    mkdirSync(path);
    writeFileSync(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Marketing ${name}\n---\nInstructions for ${name}.`,
    );
    return { name, package_path: path };
  });
  const set = createSkillSet(
    { name: "Corey Haines Marketing", harnesses: ["codex"], skills: packages },
    { configRoot },
  );
  const hit = searchLocalSkills({ query: "copywriting", configRoot, searchDirs: [] }).results[0];
  if (!hit) throw new Error("Missing fixture search hit");
  return { root, configRoot, project, source, set, hit };
}
test("search → preview → selected activation → load → cleanup keeps Library and nonselected skills untouched", () => {
  const { configRoot, project, hit } = fixture();
  const options = {
    selection: { ids: [hit.id] },
    project,
    task: "session-one",
    harness: "codex",
    configRoot,
    searchDirs: [],
  } satisfies ActivationOptions;
  expect(previewActivation(options).creates).toBe(1);
  expect(existsSync(join(project, ".agents"))).toBe(false);
  const receipt = activateSkills(options);
  const target = join(project, ".agents", "skills", "copywriting");
  expect(lstatSync(target).isSymbolicLink()).toBe(true);
  expect(existsSync(join(project, ".agents", "skills", "email"))).toBe(false);
  expect(loadSkill(hit.id, { configRoot, searchDirs: [] }).content).toContain(
    "Instructions for copywriting",
  );
  expect(activateSkills(options).receipt_id).toBe(receipt.receipt_id);
  expect(activeSkills({ configRoot, project, task: "session-one" })).toHaveLength(1);
  const cleanup = { configRoot, project, owner: { task: "session-one" } };
  expect(previewDeactivation(cleanup)[0]?.paths).toEqual([target]);
  expect(existsSync(target)).toBe(true);
  deactivateSkills(cleanup);
  expect(existsSync(target)).toBe(false);
  expect(activeSkills({ configRoot, project })).toEqual([]);
  expect(deactivateSkills(cleanup)).toEqual([]);
  expect(existsSync(hit.skill_path)).toBe(true);
  expect(listSkillSets({ configRoot })).toHaveLength(1);
});
test("whole collection activation supports all harnesses and interrupted receipt recovery", () => {
  const { configRoot, project, set } = fixture();
  const harnesses = [
    "codex",
    "claude_code",
    "opencode",
    "openclaw",
    "pi",
  ] satisfies import("@selftune/library").SkillSetHarnessId[];
  for (const harness of harnesses) {
    const options = {
      selection: { setId: set.set_id },
      project,
      task: `task-${harness}`,
      harness,
      configRoot,
    };
    const receipt = activateSkills(options);
    expect(receipt.operations).toHaveLength(2);
    const path = join(configRoot, "skill-set-receipts", `${receipt.receipt_id}.json`);
    writeFileSync(path, JSON.stringify({ ...receipt, status: "applying" }));
    expect(() => activateSkills(options)).toThrow("interrupted");
    deactivateSkills({ configRoot, project, owner: { task: options.task } });
  }
  expect(activeSkills({ configRoot, project })).toEqual([]);
});
test("preserves conflicting files, rejects stale IDs and cross-project cleanup", () => {
  const { configRoot, project, hit, root } = fixture();
  const options = {
    selection: { ids: [hit.id] },
    project,
    task: "task-a",
    harness: "codex",
    configRoot,
    searchDirs: [],
  } satisfies ActivationOptions;
  const receipt = activateSkills(options);
  const other = join(root, "other");
  mkdirSync(other);
  expect(() =>
    deactivateSkills({ configRoot, project: other, owner: { receipt: receipt.receipt_id } }),
  ).toThrow("this project");
  expect(() => activateSkills({ ...options, task: "task-b" })).toThrow("reserved");
  expect(() => activateSkills({ ...options, selection: { ids: ["missing@revision"] } })).toThrow(
    "stale",
  );
  const target = join(project, ".agents", "skills", "copywriting");
  rmSync(target);
  mkdirSync(target);
  writeFileSync(join(target, "SKILL.md"), "User edits");
  expect(() => deactivateSkills({ configRoot, project, owner: { task: "task-a" } })).toThrow(
    "replaced",
  );
  expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("User edits");
});
test("public CLI previews by default, applies only with approval, and cleans up after a fresh process", () => {
  const { configRoot, project, set } = fixture();
  const command = resolve(import.meta.dir, "../../apps/cli/src/main.ts");
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, command, "skills", ...args, "--json"], {
      env: { ...process.env, SELFTUNE_CONFIG_DIR: configRoot },
      cwd: project,
    });
  const selection = ["--set", set.set_id, "--task", "cli-task", "--harness", "codex"];
  const preview = run("activate", ...selection);
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout.toString()).toContain('"status": "preview"');
  expect(existsSync(join(project, ".agents"))).toBe(false);
  expect(run("activate", ...selection, "--yes").exitCode).toBe(0);
  expect(run("activate", ...selection, "--yes").exitCode).toBe(0);
  expect(run("active").stdout.toString()).toContain('"temporary_task": "cli-task"');
  expect(run("deactivate", "--task", "cli-task").stdout.toString()).toContain(
    '"status": "preview"',
  );
  expect(run("deactivate", "--task", "cli-task", "--yes").exitCode).toBe(0);
  expect(run("active").stdout.toString()).toContain('"activations": []');
  expect(run("activate", ...selection, "--id", "x").exitCode).not.toBe(0);
});
