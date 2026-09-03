import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSkillSet } from "@selftune/library";
import { BM25Index } from "../../packages/runtime/skill-search/bm25.js";
import { searchLocalSkills } from "../../packages/runtime/skill-search/search.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-search-test-"));
  temporary.push(root);
  const configRoot = join(root, "config");
  const skills = join(root, "skills");
  mkdirSync(skills);
  return { root, configRoot, skills };
}
function skill(root: string, name: string, description: string, body = "") {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  author: Corey Haines\n---\n${body}`,
  );
  return path;
}

describe("local BM25", () => {
  test("ranks rare terms and normalizes document length", () => {
    const index = new BM25Index([
      { id: "short", text: "marketing conversions" },
      { id: "long", text: `marketing conversions ${"unrelated ".repeat(100)}` },
      { id: "other", text: "marketing email" },
    ]);
    expect(index.search("conversions").map((hit) => hit.id)).toEqual(["short", "long"]);
    expect(index.search("missing")).toEqual([]);
    expect(index.search("the and")).toEqual([]);
    expect(index.search("marketing", 1)).toHaveLength(1);
  });
  test("handles Unicode, punctuation, repeated query terms, and stable ties", () => {
    const index = new BM25Index([
      { id: "b", text: "تسويق landing-page" },
      { id: "a", text: "تسويق landing-page" },
    ]);
    expect(index.search("تسويق").map((hit) => hit.id)).toEqual(["a", "b"]);
    expect(index.search("landing landing")).toEqual(index.search("landing"));
    expect(index.search("LANDING-page")).toHaveLength(2);
  });
});

describe("local Library discovery", () => {
  test("finds an inactive collection, preserves files, and returns compact metadata", () => {
    const { root, configRoot, skills } = fixture();
    const path = skill(skills, "page-cro", "Improve landing page conversions", "BODY_ONLY_MARKER");
    const set = createSkillSet(
      {
        name: "Corey Haines Marketing",
        harnesses: ["codex"],
        skills: [{ name: "page-cro", package_path: path }],
      },
      { configRoot },
    );
    const before = readFileSync(join(path, "SKILL.md"), "utf8");
    const names = readdirSync(root);
    const result = searchLocalSkills({
      query: "Corey Haines marketing",
      configRoot,
      searchDirs: [],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.collections).toContainEqual({ set_id: set.set_id, name: set.name });
    expect(result.results[0]?.revision).toBeTruthy();
    expect(JSON.stringify(result.results)).not.toContain("BODY_ONLY_MARKER");
    expect(readFileSync(join(path, "SKILL.md"), "utf8")).toBe(before);
    expect(readdirSync(root)).toEqual(names);
    expect(
      searchLocalSkills({ query: "conversions", configRoot, searchDirs: [] }).results,
    ).toHaveLength(1);
    expect(
      searchLocalSkills({ query: "page-cro", configRoot, searchDirs: [skills] }).results,
    ).toHaveLength(1);
  });
  test("keeps different revisions with the same name distinguishable", () => {
    const { root, configRoot } = fixture();
    const first = join(root, "one");
    const second = join(root, "two");
    skill(first, "marketing", "email campaigns");
    skill(second, "marketing", "landing pages");
    const result = searchLocalSkills({
      query: "marketing",
      configRoot,
      searchDirs: [first, second],
    });
    expect(result.results).toHaveLength(2);
    expect(new Set(result.results.map((hit) => hit.id)).size).toBe(2);
  });
  test("does not present changed cached bytes as a pinned collection revision", () => {
    const { configRoot, skills } = fixture();
    const path = skill(skills, "marketing", "Original copy");
    const set = createSkillSet(
      {
        name: "Marketing Set",
        harnesses: ["codex"],
        skills: [{ name: "marketing", package_path: path }],
      },
      { configRoot },
    );
    const cached = set.skills[0];
    if (!cached) throw new Error("Expected cached fixture");
    writeFileSync(
      join(cached.library_package_path, "SKILL.md"),
      "---\nname: marketing\ndescription: changed instructions\n---\n",
    );
    const result = searchLocalSkills({ query: "changed", configRoot, searchDirs: [] });
    expect(result.results.some((hit) => hit.revision === cached.content_hash)).toBe(false);
    expect(result.warnings.some((warning) => warning.message.includes("no longer match"))).toBe(
      true,
    );
  });
  test("finds metadata author, ignores arbitrary resource files, rejects invalid inputs", () => {
    const { configRoot, skills } = fixture();
    const path = skill(skills, "copywriting", "Write concise copy");
    writeFileSync(join(path, "credentials.txt"), "PRIVATE_SENTINEL");
    expect(
      searchLocalSkills({ query: "Corey", configRoot, searchDirs: [skills] }).results,
    ).toHaveLength(1);
    expect(
      searchLocalSkills({ query: "PRIVATE_SENTINEL", configRoot, searchDirs: [skills] }).results,
    ).toEqual([]);
    for (const limit of [0, -1, 21, 1.5, NaN]) {
      expect(() =>
        searchLocalSkills({ query: "copy", limit, configRoot, searchDirs: [] }),
      ).toThrow();
    }
    expect(() => searchLocalSkills({ query: " ", configRoot })).toThrow();
  });
  test("skips oversized instructions and keeps a fresh CLI invocation read-only", () => {
    const { root, configRoot, skills } = fixture();
    skill(skills, "page-cro", "Improve landing conversions");
    skill(skills, "oversized", "large", "x".repeat(256 * 1024));
    const command = resolve(import.meta.dir, "../../apps/cli/src/main.ts");
    const args = [
      process.execPath,
      command,
      "skills",
      "search",
      "conversions",
      "--search-dir",
      skills,
      "--json",
    ];
    const env = { ...process.env, SELFTUNE_CONFIG_DIR: configRoot };
    const before = readdirSync(root);
    const result = Bun.spawnSync(args, { env, cwd: root });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).toContain('"name": "page-cro"');
    expect(output).toContain("Skipped non-file or SKILL.md larger");
    expect(readdirSync(root)).toEqual(before);
    expect(Bun.spawnSync([...args, "--limit", "0"], { env, cwd: root }).exitCode).not.toBe(0);
    expect(Bun.spawnSync([...args, "--unknown"], { env, cwd: root }).exitCode).not.toBe(0);
    const empty = Bun.spawnSync(
      [
        process.execPath,
        command,
        "skills",
        "search",
        "nonexistentterm",
        "--search-dir",
        skills,
        "--json",
      ],
      { env, cwd: root },
    );
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout.toString()).toContain('"results": []');
  });
});
