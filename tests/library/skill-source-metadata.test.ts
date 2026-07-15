import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInstalledSkillMetadata } from "../../packages/runtime/skill-source-metadata.js";
import type { InstalledSkillPackage } from "../../packages/runtime/utils/skill-discovery.js";

function installed(root: string, name: string): InstalledSkillPackage {
  const packagePath = join(root, ".agents", "skills", name);
  mkdirSync(packagePath, { recursive: true });
  const skillPath = join(packagePath, "SKILL.md");
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: Test.\n---\n`);
  return {
    name,
    skill_path: skillPath,
    package_path: packagePath,
    registry_dir: join(root, ".agents", "skills"),
    modified_at: "2026-07-15T08:00:00.000Z",
    skill_scope: "global",
    skill_registry_dir: join(root, ".agents", "skills"),
  };
}

describe("installed skill source metadata", () => {
  test("reports GitHub source and a real upstream update", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-sources-"));
    try {
      const skill = installed(root, "research");
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(
        join(root, ".agents", ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: {
            research: {
              source: "example/skills",
              sourceType: "github",
              sourceUrl: "https://github.com/example/skills.git",
              skillPath: "skills/research/SKILL.md",
              skillFolderHash: "old-tree",
            },
          },
        }),
      );

      const metadata = await resolveInstalledSkillMetadata([skill], {
        homeDir: root,
        now: 1,
        githubTreeLoader: async () => ({
          sha: "root-tree",
          tree: [{ path: "skills/research", type: "tree", sha: "new-tree" }],
        }),
      });

      expect(metadata.get(skill.skill_path)).toEqual({
        origin: {
          kind: "github",
          label: "example/skills",
          url: "https://github.com/example/skills.git",
        },
        updateStatus: "available",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps local packages explicitly untracked", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-sources-"));
    try {
      const skill = installed(root, "local-helper");
      const metadata = await resolveInstalledSkillMetadata([skill], { homeDir: root });
      expect(metadata.get(skill.skill_path)?.origin.label).toBe("Local package");
      expect(metadata.get(skill.skill_path)?.updateStatus).toBe("untracked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds concurrent repository update checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-sources-"));
    try {
      const skills = Array.from({ length: 9 }, (_, index) => installed(root, `skill-${index}`));
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(
        join(root, ".agents", ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: Object.fromEntries(
            skills.map((skill, index) => [
              skill.name,
              {
                source: `example/repository-${index}`,
                sourceType: "github",
                skillPath: `skills/${skill.name}/SKILL.md`,
                skillFolderHash: `tree-${index}`,
              },
            ]),
          ),
        }),
      );

      let active = 0;
      let peak = 0;
      const metadata = await resolveInstalledSkillMetadata(skills, {
        homeDir: root,
        githubTreeLoader: async (source) => {
          const index = Number(source.split("-").at(-1));
          active += 1;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active -= 1;
          return {
            sha: "root-tree",
            tree: [{ path: `skills/skill-${index}`, type: "tree", sha: `tree-${index}` }],
          };
        },
      });

      expect(peak).toBeLessThanOrEqual(4);
      expect([...metadata.values()].every((entry) => entry.updateStatus === "current")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reuses persisted update checks across desktop processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-sources-"));
    try {
      const skill = installed(root, "cached-skill");
      const cachePath = join(root, "update-cache.json");
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(
        join(root, ".agents", ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: {
            "cached-skill": {
              source: "example/cached-skills",
              sourceType: "github",
              skillPath: "skills/cached-skill/SKILL.md",
              skillFolderHash: "current-tree",
            },
          },
        }),
      );

      let calls = 0;
      await resolveInstalledSkillMetadata([skill], {
        homeDir: root,
        updateCachePath: cachePath,
        updateCacheTtlMs: 1_000,
        now: 100,
        githubTreeLoader: async () => {
          calls += 1;
          return {
            sha: "root-tree",
            tree: [{ path: "skills/cached-skill", type: "tree", sha: "current-tree" }],
          };
        },
      });
      const metadata = await resolveInstalledSkillMetadata([skill], {
        homeDir: root,
        updateCachePath: cachePath,
        updateCacheTtlMs: 1_000,
        now: 200,
        githubTreeLoader: async () => {
          calls += 1;
          return null;
        },
      });

      expect(calls).toBe(1);
      expect(metadata.get(skill.skill_path)?.updateStatus).toBe("current");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cache-first resolution never blocks on an uncached upstream check", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-sources-"));
    try {
      const skill = installed(root, "cached-first");
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(
        join(root, ".agents", ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: {
            "cached-first": {
              source: "example/cache-first",
              sourceType: "github",
              skillPath: "skills/cached-first/SKILL.md",
              skillFolderHash: "installed-tree",
            },
          },
        }),
      );
      let treeCalls = 0;

      const metadata = await resolveInstalledSkillMetadata([skill], {
        homeDir: root,
        updateMode: "cache-first",
        githubTreeLoader: async () => {
          treeCalls += 1;
          return null;
        },
      });

      expect(treeCalls).toBe(0);
      expect(metadata.get(skill.skill_path)?.updateStatus).toBe("unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("negative-caches unavailable checks and skips credential lookup while fresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-sources-"));
    try {
      const skill = installed(root, "offline-skill");
      const cachePath = join(root, "update-cache.json");
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(
        join(root, ".agents", ".skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: {
            "offline-skill": {
              source: "example/offline-skills",
              sourceType: "github",
              skillPath: "skills/offline-skill/SKILL.md",
              skillFolderHash: "current-tree",
            },
          },
        }),
      );

      let treeCalls = 0;
      let tokenCalls = 0;
      const first = await resolveInstalledSkillMetadata([skill], {
        homeDir: root,
        updateCachePath: cachePath,
        updateCacheTtlMs: 1_000,
        now: 100,
        githubTreeLoader: async () => {
          treeCalls += 1;
          return null;
        },
      });
      const second = await resolveInstalledSkillMetadata([skill], {
        homeDir: root,
        updateCachePath: cachePath,
        updateCacheTtlMs: 1_000,
        now: 200,
        githubTokenLoader: () => {
          tokenCalls += 1;
          return "unused-token";
        },
      });

      expect(first.get(skill.skill_path)?.updateStatus).toBe("unknown");
      expect(second.get(skill.skill_path)?.updateStatus).toBe("unknown");
      expect(treeCalls).toBe(1);
      expect(tokenCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
