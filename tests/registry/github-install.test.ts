import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deriveGithubInstallSkillName,
  discoverLocalSkillPaths,
  parseGithubRegistryInstallTarget,
  resolveGithubSkillPath,
} from "../../packages/runtime/registry/github-install.js";

describe("parseGithubRegistryInstallTarget", () => {
  test("parses repo-only targets", () => {
    expect(parseGithubRegistryInstallTarget("github:acme/reviewer")).toEqual({
      owner: "acme",
      repo: "reviewer",
      repoFullName: "acme/reviewer",
      ref: null,
      skillPath: null,
    });
  });

  test("parses refs and monorepo paths", () => {
    expect(
      parseGithubRegistryInstallTarget("github:acme/reviewer//skills/code-review@release-2026"),
    ).toEqual({
      owner: "acme",
      repo: "reviewer",
      repoFullName: "acme/reviewer",
      ref: "release-2026",
      skillPath: "skills/code-review",
    });
  });
});

describe("GitHub install skill discovery", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "selftune-github-install-test-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("discovers root and nested skill paths", async () => {
    writeFileSync(path.join(repoRoot, "SKILL.md"), "# root", "utf-8");
    mkdirSync(path.join(repoRoot, "skills", "reviewer"), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", "reviewer", "SKILL.md"), "# nested", "utf-8");

    await expect(discoverLocalSkillPaths(repoRoot)).resolves.toEqual([".", "skills/reviewer"]);
  });

  test("auto-selects the only discovered skill path", async () => {
    mkdirSync(path.join(repoRoot, "skills", "reviewer"), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", "reviewer", "SKILL.md"), "# nested", "utf-8");

    await expect(resolveGithubSkillPath(repoRoot, null)).resolves.toEqual({
      skillPath: "skills/reviewer",
      availablePaths: ["skills/reviewer"],
    });
  });

  test("requires an explicit path for monorepos", async () => {
    mkdirSync(path.join(repoRoot, "skills", "reviewer"), { recursive: true });
    mkdirSync(path.join(repoRoot, "skills", "planner"), { recursive: true });
    writeFileSync(path.join(repoRoot, "skills", "reviewer", "SKILL.md"), "# reviewer", "utf-8");
    writeFileSync(path.join(repoRoot, "skills", "planner", "SKILL.md"), "# planner", "utf-8");

    await expect(resolveGithubSkillPath(repoRoot, null)).rejects.toThrow(/Multiple skills found/);
  });
});

describe("deriveGithubInstallSkillName", () => {
  test("falls back to the repository name for root installs without frontmatter", () => {
    expect(deriveGithubInstallSkillName("", ".", path.join("/tmp", "repo"), "reviewer")).toBe(
      "reviewer",
    );
  });

  test("uses the directory basename for nested installs without frontmatter", () => {
    expect(
      deriveGithubInstallSkillName(
        "",
        "skills/reviewer",
        path.join("/tmp", "repo", "skills", "reviewer"),
        "acme-repo",
      ),
    ).toBe("reviewer");
  });
});
