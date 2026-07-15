import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLibraryCatalog } from "../../packages/runtime/library-catalog.js";
import { quarantineSkill } from "../../packages/runtime/skill-portfolio.js";
import { createSkillSet } from "../../packages/runtime/skill-sets.js";
import { findInstalledSkillPackages } from "../../packages/runtime/utils/skill-discovery.js";

function createSkill(registry: string, name: string): string {
  const packagePath = join(registry, name);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`,
  );
  writeFileSync(join(packagePath, "reference.md"), `Reference for ${name}.\n`);
  return packagePath;
}

describe("Skill Library filesystem reconciliation", () => {
  test("hashes a symlinked package once per reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-library-hash-"));
    try {
      const source = createSkill(join(root, "source"), "research");
      const openCodeRegistry = join(root, ".opencode", "skills");
      const codexRegistry = join(root, ".agents", "skills");
      mkdirSync(openCodeRegistry, { recursive: true });
      mkdirSync(codexRegistry, { recursive: true });
      symlinkSync(source, join(openCodeRegistry, "research"));
      symlinkSync(source, join(codexRegistry, "research"));
      let hashCalls = 0;

      const snapshot = await loadLibraryCatalog({
        searchDirs: [openCodeRegistry, codexRegistry],
        skillSetConfigRoot: join(root, "config"),
        sourceMetadata: { homeDir: root },
        usageRows: [],
        versionHashLoader: () => {
          hashCalls += 1;
          return "shared-version";
        },
      });

      expect(snapshot.skills).toHaveLength(1);
      expect(snapshot.skills[0]?.locations).toHaveLength(2);
      expect(hashCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("groups cached revisions with installs and preserves archived harness identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-library-"));
    try {
      const configRoot = join(root, "config");
      const quarantineRoot = join(configRoot, "quarantine");
      const openCodeRegistry = join(root, ".opencode", "skills");
      const openClawRegistry = join(root, ".openclaw", "skills");
      const researchPath = createSkill(openCodeRegistry, "research");
      createSkill(openClawRegistry, "review");
      createSkill(join(configRoot, "library", "drafts"), "release-notes");

      createSkillSet(
        {
          name: "Research projects",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: researchPath }],
        },
        { configRoot, now: new Date("2026-07-15T08:00:00.000Z") },
      );

      const installed = findInstalledSkillPackages([openCodeRegistry, openClawRegistry]);
      const review = installed.find((skill) => skill.name === "review");
      expect(review).toBeDefined();
      quarantineSkill({
        installedSkills: installed,
        skillName: "review",
        skillPath: review?.skill_path,
        quarantineRoot,
        now: new Date("2026-07-15T09:00:00.000Z"),
      });

      const snapshot = await loadLibraryCatalog({
        searchDirs: [openCodeRegistry, openClawRegistry],
        skillSetConfigRoot: configRoot,
        quarantineRoot,
        sourceMetadata: { homeDir: root },
        usageRows: [
          {
            skill_name: "research",
            skill_path: join(researchPath, "SKILL.md"),
            session_id: "session-1",
            occurred_at: "2026-07-15T07:30:00.000Z",
            triggered: 1,
            matched_prompt_id: null,
            confidence: 1,
            invocation_mode: "explicit",
            query_text: "Use the research skill",
          },
          {
            skill_name: "research",
            skill_path: join(researchPath, "SKILL.md"),
            session_id: "session-2",
            occurred_at: "2026-07-15T08:30:00.000Z",
            triggered: 0,
            matched_prompt_id: null,
            confidence: 0.8,
            invocation_mode: "contextual",
            query_text: "Research the implementation",
          },
        ],
      });

      expect(snapshot.skills.map((skill) => [skill.name, skill.lifecycle])).toEqual([
        ["release-notes", "draft"],
        ["research", "active"],
        ["review", "archived"],
      ]);
      expect(snapshot.skills[0]?.locations[0]?.sourceKind).toBe("draft");
      expect(snapshot.skills[1]?.locations.map((location) => location.sourceKind)).toEqual([
        "cached",
        "installed",
      ]);
      expect(snapshot.skills[1]?.locations[1]?.harness).toBe("opencode");
      expect(snapshot.skills[1]?.revisions).toHaveLength(1);
      expect(snapshot.skills[1]?.lastUsedAt).toBe("2026-07-15T07:30:00.000Z");
      expect(snapshot.skills[1]?.lastModifiedAt).toBeTruthy();
      expect(snapshot.skills[1]?.origins[0]?.label).toBe("Local package");
      expect(snapshot.skills[1]?.updateStatus).toBe("untracked");
      expect(snapshot.skills[2]?.locations[0]?.harness).toBe("openclaw");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
