import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSkillSet,
  exportPortableSkillSetPackBytes,
  importPortableSkillSetPack,
} from "@selftune/library";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable Skill Set Packs", () => {
  test("round-trips sealed skill contents into an independent local library", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-pack-roundtrip-"));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const skillRoot = join(root, "review");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review\ndescription: Review code\nlicense: MIT\n---\n# Review\n",
    );
    writeFileSync(join(skillRoot, "reference.md"), "Pinned reference\n");
    const source = createSkillSet(
      {
        name: "Engineering",
        description: "Pinned engineering workflow",
        harnesses: ["codex"],
        skills: [{ name: "review", package_path: skillRoot }],
      },
      { configRoot: sourceRoot },
    );

    const bytes = exportPortableSkillSetPackBytes(source.set_id, { configRoot: sourceRoot });
    const imported = importPortableSkillSetPack(bytes, { configRoot: targetRoot });

    expect(imported.manifest.name).toBe("Engineering");
    expect(imported.manifest.skills).toHaveLength(1);
    expect(
      readFileSync(join(imported.manifest.skills[0]!.library_package_path, "reference.md"), "utf8"),
    ).toBe("Pinned reference\n");
    expect(imported.sourceRevisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imported.objectSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("blocks Pack export when a component has no distributable license evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-pack-unlicensed-"));
    temporaryDirectories.push(root);
    const skillRoot = join(root, "private-skill");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: private-skill\ndescription: Internal\n---\n# Private\n",
    );
    const set = createSkillSet(
      {
        name: "Private",
        harnesses: ["codex"],
        skills: [{ name: "private-skill", package_path: skillRoot }],
      },
      { configRoot: join(root, "config") },
    );
    expect(() =>
      exportPortableSkillSetPackBytes(set.set_id, { configRoot: join(root, "config") }),
    ).toThrow("requires a license");
  });
});
