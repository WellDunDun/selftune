import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSkillSet } from "@selftune/library";
import {
  activateSkills,
  activeSkills,
  deactivateSkills,
  loadSkill,
} from "../../packages/runtime/skill-search/activation.js";
import { searchLocalSkills } from "../../packages/runtime/skill-search/search.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(count = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "selftune-activation-e2e-")));
  roots.push(root);
  const configRoot = join(root, "config");
  const project = join(root, "project");
  mkdirSync(project);
  const skills = Array.from({ length: count }, (_, index) => {
    const name = `marketing-${index}`;
    const package_path = join(root, name);
    mkdirSync(package_path);
    writeFileSync(
      join(package_path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Marketing workflow ${index}\n---\nUse workflow ${index}.`,
    );
    return { name, package_path };
  });
  const set = createSkillSet(
    { name: "Marketing collection", harnesses: ["codex"], skills },
    { configRoot },
  );
  return { configRoot, project, set };
}

test("a 24-skill collection loads one selected skill without installing the other 23", () => {
  const { configRoot, project, set } = fixture(24);
  const result = searchLocalSkills({
    query: "marketing-23",
    limit: 20,
    configRoot,
    searchDirs: [],
  });
  const selected = result.results.find((hit) => hit.name === "marketing-23");
  if (!selected) throw new Error("Expected the exact skill in the result page");
  expect(result.indexed).toBe(24);
  expect(loadSkill(selected.id, { configRoot, searchDirs: [] }).content).toContain(
    "Use workflow 23",
  );
  expect(existsSync(join(project, ".agents"))).toBe(false);
  const receipt = activateSkills({
    project,
    configRoot,
    task: "campaign",
    harness: "codex",
    selection: { ids: [selected.id] },
    searchDirs: [],
  });
  expect(receipt.operations).toHaveLength(1);
  expect(existsSync(join(project, ".agents", "skills", "marketing-23"))).toBe(true);
  for (let index = 0; index < 23; index++)
    expect(existsSync(join(project, ".agents", "skills", `marketing-${index}`))).toBe(false);
  deactivateSkills({ project, configRoot, owner: { task: "campaign" } });
  expect(activeSkills({ project, configRoot })).toEqual([]);
  expect(set.skills.every((skill) => existsSync(skill.library_package_path))).toBe(true);
});

test("parallel CLI tasks never share ownership of a temporary target", async () => {
  const { configRoot, project, set } = fixture();
  const cli = resolve(import.meta.dir, "../../apps/cli/src/main.ts");
  for (let round = 0; round < 3; round++) {
    const children = ["one", "two"].map((task) =>
      Bun.spawn(
        [
          process.execPath,
          cli,
          "skills",
          "activate",
          "--set",
          set.set_id,
          "--task",
          task,
          "--harness",
          "codex",
          "--yes",
          "--json",
        ],
        {
          cwd: project,
          env: { ...process.env, SELFTUNE_CONFIG_DIR: configRoot },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    const outcomes = await Promise.all(
      children.map(async (child) => {
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exit, stdout, stderr };
      }),
    );
    expect(outcomes.filter((outcome) => outcome.exit === 0).length).toBeLessThanOrEqual(1);
    const active = activeSkills({ project, configRoot });
    expect(active.length).toBe(outcomes.filter((outcome) => outcome.exit === 0).length);
    for (const task of ["one", "two"]) deactivateSkills({ project, configRoot, owner: { task } });
    expect(existsSync(join(project, ".agents", "skills", "marketing-0"))).toBe(false);
  }
});
