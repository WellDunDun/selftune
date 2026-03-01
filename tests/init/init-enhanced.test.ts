import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectWorkspaceType,
  type WorkspaceInfo,
} from "../../cli/selftune/init.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-init-enhanced-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detectWorkspaceType
// ---------------------------------------------------------------------------

describe("detectWorkspaceType", () => {
  test("returns unknown when no SKILL.md files found", () => {
    const result = detectWorkspaceType(tmpDir);
    expect(result.type).toBe("unknown");
    expect(result.skillCount).toBe(0);
    expect(result.skillPaths).toEqual([]);
  });

  test("detects single-skill project with one SKILL.md", () => {
    const skillDir = join(tmpDir, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# My Skill\nDescription here");

    const result = detectWorkspaceType(tmpDir);
    expect(result.type).toBe("single-skill");
    expect(result.skillCount).toBe(1);
    expect(result.skillPaths).toHaveLength(1);
    expect(result.skillPaths[0]).toContain("SKILL.md");
  });

  test("detects multi-skill project with multiple SKILL.md files", () => {
    const skill1 = join(tmpDir, "skills", "auth");
    const skill2 = join(tmpDir, "skills", "deploy");
    mkdirSync(skill1, { recursive: true });
    mkdirSync(skill2, { recursive: true });
    writeFileSync(join(skill1, "SKILL.md"), "# Auth Skill");
    writeFileSync(join(skill2, "SKILL.md"), "# Deploy Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.type).toBe("multi-skill");
    expect(result.skillCount).toBe(2);
    expect(result.skillPaths).toHaveLength(2);
  });

  test("detects monorepo with package.json workspaces", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const pkgDir = join(tmpDir, "packages", "core", "skill");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "SKILL.md"), "# Core Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.type).toBe("monorepo");
    expect(result.isMonorepo).toBe(true);
    expect(result.skillCount).toBe(1);
  });

  test("detects monorepo with pnpm-workspace.yaml", () => {
    writeFileSync(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const skillDir = join(tmpDir, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.isMonorepo).toBe(true);
  });

  test("ignores node_modules directories", () => {
    const nmSkill = join(tmpDir, "node_modules", "some-pkg", "skill");
    mkdirSync(nmSkill, { recursive: true });
    writeFileSync(join(nmSkill, "SKILL.md"), "# Should be ignored");

    const realSkill = join(tmpDir, "skill");
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(join(realSkill, "SKILL.md"), "# Real Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.skillCount).toBe(1);
    expect(result.skillPaths).toHaveLength(1);
  });

  test("ignores .git directories", () => {
    const gitSkill = join(tmpDir, ".git", "skill");
    mkdirSync(gitSkill, { recursive: true });
    writeFileSync(join(gitSkill, "SKILL.md"), "# Should be ignored");

    const result = detectWorkspaceType(tmpDir);
    expect(result.skillCount).toBe(0);
  });

  test("detects existing hooks in the project", () => {
    const hooksDir = join(tmpDir, "cli", "selftune", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "prompt-log.ts"), "// hook");

    const skillDir = join(tmpDir, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.hasExistingHooks).toBe(true);
  });

  test("suggests single-skill template for single-skill project", () => {
    const skillDir = join(tmpDir, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.suggestedTemplate).toBe("single-skill");
  });

  test("suggests multi-skill template for multi-skill project", () => {
    const skill1 = join(tmpDir, "skills", "a");
    const skill2 = join(tmpDir, "skills", "b");
    mkdirSync(skill1, { recursive: true });
    mkdirSync(skill2, { recursive: true });
    writeFileSync(join(skill1, "SKILL.md"), "# A");
    writeFileSync(join(skill2, "SKILL.md"), "# B");

    const result = detectWorkspaceType(tmpDir);
    expect(result.suggestedTemplate).toBe("multi-skill");
  });

  test("suggests multi-skill template for monorepo", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const skillDir = join(tmpDir, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.suggestedTemplate).toBe("multi-skill");
  });

  test("returns consistent WorkspaceInfo shape", () => {
    const result = detectWorkspaceType(tmpDir);
    expect(result).toHaveProperty("type");
    expect(result).toHaveProperty("skillCount");
    expect(result).toHaveProperty("skillPaths");
    expect(result).toHaveProperty("isMonorepo");
    expect(result).toHaveProperty("hasExistingHooks");
    expect(result).toHaveProperty("suggestedTemplate");
    expect(typeof result.type).toBe("string");
    expect(typeof result.skillCount).toBe("number");
    expect(Array.isArray(result.skillPaths)).toBe(true);
    expect(typeof result.isMonorepo).toBe("boolean");
    expect(typeof result.hasExistingHooks).toBe("boolean");
  });

  test("handles deeply nested SKILL.md files", () => {
    const deep = join(tmpDir, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "SKILL.md"), "# Deep Skill");

    const result = detectWorkspaceType(tmpDir);
    expect(result.skillCount).toBe(1);
    expect(result.skillPaths[0]).toContain("SKILL.md");
  });
});
