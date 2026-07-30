import { describe, expect, test } from "bun:test";
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
import { join } from "node:path";
import * as Effect from "effect/Effect";

import {
  decideSkillConsolidation,
  prepareSkillConsolidationDecision,
  rollbackSkillConsolidationDecision,
} from "../../packages/runtime/consolidation-decisions.js";
import { computeSkillVersionHash } from "../../packages/runtime/utils/skill-discovery.js";
import {
  runSkillsConsolidateProgram,
  runSkillsConsolidationRollbackProgram,
} from "../../packages/runtime/skill-portfolio/consolidation-programs.js";

function createSkill(registry: string, name: string, body: string): string {
  const packagePath = join(registry, name);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n\n${body}\n`,
  );
  return packagePath;
}

describe("skill installation consolidation", () => {
  test("rejects an empty additional search directory before catalog access", async () => {
    const error = await Effect.runPromise(
      runSkillsConsolidateProgram({
        skill: "research",
        searchDirs: [""],
        dryRun: true,
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "INVALID_FLAG",
      message: "--search-dir must not be empty.",
    });
  });

  test("previews a single skill without writing decisions or changing installations", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-consolidation-preview-"));
    const previousSelfTuneHome = process.env.SELFTUNE_HOME;
    try {
      const configRoot = join(root, "config");
      process.env.SELFTUNE_HOME = join(root, "home");
      const globalRegistry = join(root, "home", ".agents", "skills");
      const projectRegistry = join(root, "project", ".agents", "skills");
      const canonical = createSkill(globalRegistry, "research", "Canonical workflow.");
      const target = createSkill(projectRegistry, "research", "Old workflow.");
      const searchDirs = [globalRegistry, projectRegistry];
      const sourceCachePath = join(root, "source-cache.json");
      let sourceChecks = 0;
      writeFileSync(
        join(root, "home", ".agents", ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: {
            research: {
              source: "example/skills",
              sourceType: "github",
              skillPath: "skills/research/SKILL.md",
              skillFolderHash: "current-tree",
            },
          },
        }),
      );

      const result = await Effect.runPromise(
        runSkillsConsolidateProgram(
          { skill: "research", searchDirs, dryRun: true },
          {
            catalog: {
              searchDirs: [],
              skillSetConfigRoot: configRoot,
              usageRows: [],
              sourceMetadata: {
                homeDir: join(root, "home"),
                updateCachePath: sourceCachePath,
                githubTreeLoader: async () => {
                  sourceChecks += 1;
                  return null;
                },
              },
            },
            decisions: {
              configRoot,
              quarantineRoot: join(configRoot, "quarantine"),
              searchDirs,
            },
          },
        ),
      );

      expect(result).toMatchObject({
        success: true,
        operation: "consolidate_skill_installations",
        dry_run: true,
        mode: "single",
        requested_skill: "research",
        counts: { recommended: 1, selected: 1, planned: 1, applied: 0, review_required: 0 },
        items: [
          {
            skill_name: "research",
            status: "planned",
            confidence: "review_required",
            canonical: { package_path: canonical },
            targets: [{ action: "replace_with_link", package_path: target }],
          },
        ],
      });
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(existsSync(join(configRoot, "decisions"))).toBe(false);
      expect(sourceChecks).toBe(0);
      expect(existsSync(sourceCachePath)).toBe(false);
    } finally {
      if (previousSelfTuneHome === undefined) delete process.env.SELFTUNE_HOME;
      else process.env.SELFTUNE_HOME = previousSelfTuneHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("applies a reviewed CLI consolidation and returns a durable undo receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-consolidation-program-"));
    const previousSelfTuneHome = process.env.SELFTUNE_HOME;
    try {
      const configRoot = join(root, "config");
      process.env.SELFTUNE_HOME = join(root, "home");
      const globalRegistry = join(root, "home", ".agents", "skills");
      const projectRegistry = join(root, "project", ".agents", "skills");
      createSkill(globalRegistry, "research", "Canonical workflow.");
      const target = createSkill(projectRegistry, "research", "Old workflow.");
      const searchDirs = [globalRegistry, projectRegistry];

      const result = await Effect.runPromise(
        runSkillsConsolidateProgram(
          { skill: "research", searchDirs, approved: true },
          {
            catalog: { searchDirs: [], skillSetConfigRoot: configRoot, usageRows: [] },
            decisions: {
              configRoot,
              quarantineRoot: join(configRoot, "quarantine"),
              searchDirs,
            },
          },
        ),
      );

      expect(result).toMatchObject({
        success: true,
        dry_run: false,
        counts: { selected: 1, planned: 0, applied: 1, failed: 0 },
        items: [
          {
            skill_name: "research",
            status: "applied",
            decision_id: expect.any(String),
            receipt_id: expect.any(String),
            applied_at: expect.any(String),
            rollback_behavior: expect.stringContaining("Rollback removes"),
            undo_command: expect.stringContaining("selftune skills consolidation-rollback --id"),
            error: null,
          },
        ],
      });
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(realpathSync(result.items[0]?.canonical.library_package_path ?? "")).toBe(
        realpathSync(target),
      );
      expect(typeof result.items[0]?.targets[0]?.archive_id).toBe("string");
      expect(existsSync(result.items[0]?.targets[0]?.archive_destination ?? "")).toBe(true);

      const repeated = await Effect.runPromise(
        runSkillsConsolidateProgram(
          { skill: "research", searchDirs, approved: true },
          {
            catalog: { searchDirs: [], skillSetConfigRoot: configRoot, usageRows: [] },
            decisions: {
              configRoot,
              quarantineRoot: join(configRoot, "quarantine"),
              searchDirs,
            },
          },
        ),
      );
      expect(repeated).toMatchObject({
        success: true,
        already_consolidated: true,
        counts: { applied: 0, failed: 0 },
        items: [],
      });
    } finally {
      if (previousSelfTuneHome === undefined) delete process.env.SELFTUNE_HOME;
      else process.env.SELFTUNE_HOME = previousSelfTuneHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rolls back an applied CLI consolidation and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-consolidation-rollback-program-"));
    const previousSelfTuneHome = process.env.SELFTUNE_HOME;
    try {
      const configRoot = join(root, "config");
      process.env.SELFTUNE_HOME = join(root, "home");
      const globalRegistry = join(root, "home", ".agents", "skills");
      const projectRegistry = join(root, "project", ".agents", "skills");
      createSkill(globalRegistry, "research", "Canonical workflow.");
      const target = createSkill(projectRegistry, "research", "Old workflow.");
      const searchDirs = [globalRegistry, projectRegistry];
      const runtime = {
        catalog: { searchDirs: [], skillSetConfigRoot: configRoot, usageRows: [] },
        decisions: {
          configRoot,
          quarantineRoot: join(configRoot, "quarantine"),
          searchDirs,
        },
      };
      const applied = await Effect.runPromise(
        runSkillsConsolidateProgram({ skill: "research", searchDirs, approved: true }, runtime),
      );
      const decisionId = applied.items[0]?.decision_id ?? "";

      const preview = await Effect.runPromise(
        runSkillsConsolidationRollbackProgram({ id: decisionId, dryRun: true }, runtime),
      );
      expect(preview).toMatchObject({
        success: true,
        operation: "rollback_skill_consolidation",
        dry_run: true,
        decision_id: decisionId,
        status: "planned",
        restored_paths: [target],
      });
      expect(lstatSync(target).isSymbolicLink()).toBe(true);

      const rolledBack = await Effect.runPromise(
        runSkillsConsolidationRollbackProgram({ id: decisionId, approved: true }, runtime),
      );
      expect(rolledBack).toMatchObject({
        success: true,
        dry_run: false,
        decision_id: decisionId,
        status: "rolled_back",
      });
      expect(lstatSync(target).isSymbolicLink()).toBe(false);

      const repeated = await Effect.runPromise(
        runSkillsConsolidationRollbackProgram({ id: decisionId, approved: true }, runtime),
      );
      expect(repeated.status).toBe("already_rolled_back");
    } finally {
      if (previousSelfTuneHome === undefined) delete process.env.SELFTUNE_HOME;
      else process.env.SELFTUNE_HOME = previousSelfTuneHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bulk-applies only source-confirmed recommendations and leaves ambiguous skills for review", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-consolidation-all-safe-"));
    const previousSelfTuneHome = process.env.SELFTUNE_HOME;
    try {
      const configRoot = join(root, "config");
      const homeDir = join(root, "home");
      process.env.SELFTUNE_HOME = homeDir;
      const globalRegistry = join(homeDir, ".agents", "skills");
      const projectRegistry = join(root, "project", ".agents", "skills");
      createSkill(globalRegistry, "safe-skill", "Canonical safe workflow.");
      const safeTarget = createSkill(projectRegistry, "safe-skill", "Old safe workflow.");
      createSkill(globalRegistry, "ambiguous-skill", "Possible canonical workflow.");
      const ambiguousTarget = createSkill(
        projectRegistry,
        "ambiguous-skill",
        "Different ambiguous workflow.",
      );
      mkdirSync(join(homeDir, ".agents"), { recursive: true });
      writeFileSync(
        join(homeDir, ".agents", ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: {
            "safe-skill": {
              source: "example/skills",
              sourceType: "github",
              skillPath: "skills/safe-skill/SKILL.md",
              skillFolderHash: "current-tree",
            },
          },
        }),
      );
      const searchDirs = [globalRegistry, projectRegistry];

      const result = await Effect.runPromise(
        runSkillsConsolidateProgram(
          { allSafe: true, searchDirs, approved: true },
          {
            catalog: {
              searchDirs: [],
              skillSetConfigRoot: configRoot,
              usageRows: [],
              sourceMetadata: {
                homeDir,
                updateCachePath: join(root, "source-cache.json"),
                githubTreeLoader: async () => ({
                  sha: "root-tree",
                  tree: [{ path: "skills/safe-skill", type: "tree", sha: "current-tree" }],
                }),
              },
            },
            decisions: {
              configRoot,
              quarantineRoot: join(configRoot, "quarantine"),
              searchDirs,
            },
          },
        ),
      );

      expect(result).toMatchObject({
        success: true,
        mode: "all_safe",
        counts: {
          recommended: 2,
          selected: 1,
          planned: 0,
          applied: 1,
          review_required: 1,
          failed: 0,
        },
      });
      expect(result.items.map((item) => [item.skill_name, item.status])).toEqual([
        ["ambiguous-skill", "review_required"],
        ["safe-skill", "applied"],
      ]);
      expect(lstatSync(safeTarget).isSymbolicLink()).toBe(true);
      expect(lstatSync(ambiguousTarget).isSymbolicLink()).toBe(false);
    } finally {
      if (previousSelfTuneHome === undefined) delete process.env.SELFTUNE_HOME;
      else process.env.SELFTUNE_HOME = previousSelfTuneHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archives project copies, links the canonical Library revision, and rolls back exactly", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-consolidation-"));
    try {
      const configRoot = join(root, "config");
      const quarantineRoot = join(configRoot, "quarantine");
      const globalRegistry = join(root, "home", ".agents", "skills");
      const projectA = join(root, "projects", "a");
      const projectB = join(root, "projects", "b");
      const projectARegistry = join(projectA, ".agents", "skills");
      const projectBRegistry = join(projectB, ".agents", "skills");
      const canonical = createSkill(globalRegistry, "research", "Canonical workflow.");
      const oldA = createSkill(projectARegistry, "research", "Old workflow A.");
      const oldB = createSkill(projectBRegistry, "research", "Old workflow B.");
      const oldAHash = computeSkillVersionHash(join(oldA, "SKILL.md"));
      const oldBHash = computeSkillVersionHash(join(oldB, "SKILL.md"));
      const searchDirs = [globalRegistry, projectARegistry, projectBRegistry];

      const prepared = prepareSkillConsolidationDecision(
        {
          skillName: "research",
          canonicalSkillPath: join(canonical, "SKILL.md"),
          targetSkillPaths: [join(oldA, "SKILL.md"), join(oldB, "SKILL.md")],
        },
        { configRoot, quarantineRoot, searchDirs },
      );

      expect(prepared).toMatchObject({
        requested_action: "consolidate_skill_installations",
        status: "pending",
        skill_name: "research",
        targets: [
          { action: "replace_with_link", original_package_path: oldA },
          { action: "replace_with_link", original_package_path: oldB },
        ],
      });

      const approved = await decideSkillConsolidation(prepared.approval_id, "approve", {
        configRoot,
        quarantineRoot,
        searchDirs,
      });
      expect(approved.status).toBe("approved");
      expect(lstatSync(oldA).isSymbolicLink()).toBe(true);
      expect(lstatSync(oldB).isSymbolicLink()).toBe(true);
      expect(realpathSync(oldA)).toBe(realpathSync(approved.canonical.library_package_path));
      expect(realpathSync(oldB)).toBe(realpathSync(approved.canonical.library_package_path));
      expect(approved.targets.every((target) => existsSync(target.archive_destination))).toBe(true);

      const rolledBack = rollbackSkillConsolidationDecision(prepared.approval_id, {
        configRoot,
        quarantineRoot,
        searchDirs,
      });
      expect(rolledBack.receipt?.status).toBe("rolled_back");
      expect(lstatSync(oldA).isSymbolicLink()).toBe(false);
      expect(lstatSync(oldB).isSymbolicLink()).toBe(false);
      expect(computeSkillVersionHash(join(oldA, "SKILL.md"))).toBe(oldAHash);
      expect(computeSkillVersionHash(join(oldB, "SKILL.md"))).toBe(oldBHash);
      expect(readFileSync(join(canonical, "SKILL.md"), "utf8")).toContain("Canonical workflow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks the review stale when a project copy changes before approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-consolidation-stale-"));
    try {
      const configRoot = join(root, "config");
      const globalRegistry = join(root, "home", ".agents", "skills");
      const projectRegistry = join(root, "project", ".agents", "skills");
      const canonical = createSkill(globalRegistry, "research", "Canonical workflow.");
      const target = createSkill(projectRegistry, "research", "Old workflow.");
      const options = {
        configRoot,
        quarantineRoot: join(configRoot, "quarantine"),
        searchDirs: [globalRegistry, projectRegistry],
      };
      const prepared = prepareSkillConsolidationDecision(
        {
          skillName: "research",
          canonicalSkillPath: join(canonical, "SKILL.md"),
          targetSkillPaths: [join(target, "SKILL.md")],
        },
        options,
      );
      writeFileSync(
        join(target, "SKILL.md"),
        "---\nname: research\n---\n\nChanged after review.\n",
      );

      const decision = await decideSkillConsolidation(prepared.approval_id, "approve", options);

      expect(decision.status).toBe("stale");
      expect(decision.failure?.code).toBe("CONSOLIDATION_STALE");
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(existsSync(prepared.targets[0]?.archive_destination ?? "")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
