import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installBackedLibrarySkill } from "../../packages/runtime/remote-library/install-backed-skill.js";
import { computeSkillVersionHash } from "../../packages/runtime/utils/skill-discovery.js";

describe("backed Library skill install", () => {
  test("installs a verified cached skill into the selected agent's global directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-backed-skill-install-"));
    try {
      const configRoot = join(root, "config");
      const source = join(configRoot, "library", "packages", "pending", "portable-skill");
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, "SKILL.md"),
        "---\nname: portable-skill\ndescription: Portable test skill.\n---\n",
      );
      writeFileSync(join(source, "workflow.md"), "Use the whole skill folder.\n");
      const revisionHash = computeSkillVersionHash(join(source, "SKILL.md"));
      if (!revisionHash) throw new Error("Expected a revision hash.");
      const canonicalSource = join(
        configRoot,
        "library",
        "packages",
        revisionHash,
        "portable-skill",
      );
      mkdirSync(join(configRoot, "library", "packages", revisionHash), { recursive: true });
      renameSync(source, canonicalSource);

      const catalog = await import("../../packages/runtime/library/catalog.js").then((module) =>
        module.loadLibraryCatalog({ searchDirs: [], skillSetConfigRoot: configRoot }),
      );
      const skill = catalog.skills.find((candidate) => candidate.name === "portable-skill");
      expect(skill).toBeDefined();
      if (!skill) throw new Error("Expected cached skill.");

      const receipt = await installBackedLibrarySkill(
        { skillId: skill.skillId, targetAgent: "claude_code" },
        { configRoot, homeDirectory: join(root, "home"), platform: "darwin" },
      );
      expect(receipt.targetPath).toBe(join(root, "home", ".claude", "skills", "portable-skill"));
      expect(existsSync(join(receipt.targetPath, "workflow.md"))).toBe(true);

      await expect(
        installBackedLibrarySkill(
          { skillId: skill.skillId, targetAgent: "claude_code" },
          { configRoot, homeDirectory: join(root, "home"), platform: "darwin" },
        ),
      ).rejects.toMatchObject({ code: "GUARD_BLOCKED" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
