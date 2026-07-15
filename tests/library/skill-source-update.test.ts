import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import {
  applySkillSourceUpdate,
  previewSkillSourceUpdate,
} from "../../packages/runtime/skill-source-update.js";
import type { GitHubTree } from "../../packages/runtime/skill-source-metadata.js";

function blobHash(contents: string): string {
  const bytes = Buffer.from(contents);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function folderTree(sha: string, contents: string): GitHubTree {
  return {
    sha,
    tree: [{ path: "SKILL.md", type: "blob", sha: blobHash(contents) }],
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-source-update-"));
  const packagePath = join(root, ".agents", "skills", "research");
  const lockPath = join(root, ".agents", ".skill-lock.json");
  const configRoot = join(root, ".selftune");
  const oldContents = "---\nname: research\ndescription: Old.\n---\n";
  const newContents = "---\nname: research\ndescription: New.\n---\n";
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(packagePath, "SKILL.md"), oldContents);
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        version: 3,
        skills: {
          research: {
            source: "example/skills",
            sourceType: "github",
            sourceUrl: "https://github.com/example/skills.git",
            skillPath: "skills/research/SKILL.md",
            skillFolderHash: "old-tree",
            pluginName: "example-plugin",
            installedAt: "2026-07-01T10:00:00.000Z",
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const archiveRoot = join(root, "archive-source", "example-skills", "skills", "research");
  mkdirSync(archiveRoot, { recursive: true });
  writeFileSync(join(archiveRoot, "SKILL.md"), newContents);
  const archivePath = join(root, "source.tar.gz");
  const tar = spawnSync(
    "tar",
    ["czf", archivePath, "-C", join(root, "archive-source"), "example-skills"],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) throw new Error(tar.stderr);

  const githubTreeLoader = async (
    _source: string,
    ref: string | null,
  ): Promise<GitHubTree | null> => {
    if (ref === "old-tree") return folderTree("old-tree", oldContents);
    if (ref === "new-tree") return folderTree("new-tree", newContents);
    return {
      sha: "root-tree",
      tree: [{ path: "skills/research", type: "tree", sha: "new-tree" }],
    };
  };

  return {
    root,
    packagePath,
    lockPath,
    configRoot,
    oldContents,
    newContents,
    options: {
      homeDir: root,
      configRoot,
      searchDirs: [join(root, ".agents", "skills")],
      githubTreeLoader,
      archiveLoader: async () => readFileSync(archivePath),
      now: Date.parse("2026-07-15T10:00:00.000Z"),
    },
  };
}

describe("skill source updates", () => {
  test("previews a clean update against the recorded upstream revision", async () => {
    const fixture = createFixture();
    try {
      const preview = await previewSkillSourceUpdate("research", fixture.options);
      expect(preview.status).toBe("available");
      expect(preview.conflicts).toBe(0);
      expect(preview.can_apply).toBe(true);
      expect(preview.locations[0]?.local_state).toBe("clean");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("blocks local edits until upstream replacement is explicit", async () => {
    const fixture = createFixture();
    try {
      writeFileSync(join(fixture.packagePath, "SKILL.md"), `${fixture.oldContents}\nLocal edit.\n`);
      const preview = await previewSkillSourceUpdate("research", fixture.options);
      expect(preview.conflicts).toBe(1);
      expect(preview.can_apply).toBe(false);
      expect(preview.locations[0]?.local_state).toBe("modified");

      await expect(
        applySkillSourceUpdate("research", "abort", fixture.options),
      ).rejects.toMatchObject({ code: "LOCAL_CHANGES" });
      expect(readFileSync(join(fixture.packagePath, "SKILL.md"), "utf8")).toContain("Local edit");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("backs up, replaces, and advances the source lock", async () => {
    const fixture = createFixture();
    try {
      writeFileSync(join(fixture.packagePath, "SKILL.md"), `${fixture.oldContents}\nLocal edit.\n`);
      const receipt = await applySkillSourceUpdate("research", "take_upstream", fixture.options);

      expect(receipt.status).toBe("applied");
      expect(readFileSync(join(fixture.packagePath, "SKILL.md"), "utf8")).toBe(fixture.newContents);
      expect(existsSync(receipt.operations[0]?.backup_path ?? "")).toBe(true);
      expect(
        readFileSync(join(receipt.operations[0]?.backup_path ?? "", "SKILL.md"), "utf8"),
      ).toContain("Local edit");
      const lock = JSON.parse(readFileSync(fixture.lockPath, "utf8"));
      expect(lock.skills.research.skillFolderHash).toBe("new-tree");
      expect(lock.skills.research.pluginName).toBe("example-plugin");
      expect(lock.skills.research.installedAt).toBe("2026-07-01T10:00:00.000Z");
      expect(lock.skills.research.updatedAt).toBeTruthy();
      expect(
        existsSync(
          join(fixture.configRoot, "skill-update-receipts", receipt.receipt_id, "receipt.json"),
        ),
      ).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
