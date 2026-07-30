import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import {
  applyPreparedSkillSourceMerge,
  applySkillSourceUpdate,
  prepareSkillSourceMerge,
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

  const createArchive = (name: string, contents: string) => {
    const sourceRoot = join(root, `archive-${name}`);
    const archiveRoot = join(sourceRoot, "example-skills", "skills", "research");
    mkdirSync(archiveRoot, { recursive: true });
    writeFileSync(join(archiveRoot, "SKILL.md"), contents);
    const archivePath = join(root, `${name}.tar.gz`);
    const tar = spawnSync("tar", ["czf", archivePath, "-C", sourceRoot, "example-skills"], {
      encoding: "utf8",
    });
    if (tar.status !== 0) throw new Error(tar.stderr);
    return archivePath;
  };
  const oldArchivePath = createArchive("old", oldContents);
  const newArchivePath = createArchive("new", newContents);

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
      githubBlobLoader: async (_source: string, sha: string) => {
        if (sha === blobHash(oldContents)) return Buffer.from(oldContents);
        if (sha === blobHash(newContents)) return Buffer.from(newContents);
        return null;
      },
      archiveLoader: async (_source: string, ref: string | null) =>
        readFileSync(ref === "old-tree" ? oldArchivePath : newArchivePath),
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
      expect(preview.upstream_diff).toContain("description: New.");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("prepares an agent-resolved three-way merge and applies it after review", async () => {
    const fixture = createFixture();
    try {
      const localContents = "---\nname: research\ndescription: Locally tailored.\n---\n";
      const mergedContents =
        "---\nname: research\ndescription: New upstream, locally tailored.\n---\n";
      writeFileSync(join(fixture.packagePath, "SKILL.md"), localContents);
      const merge = await prepareSkillSourceMerge("research", "codex", "gpt-test", {
        ...fixture.options,
        agentCaller: async (_system, user, agent, model) => {
          expect(agent).toBe("codex");
          expect(model).toBe("gpt-test");
          expect(JSON.parse(user).conflicts[0].path).toBe("SKILL.md");
          return JSON.stringify({
            summary: "Preserved the local wording while adopting upstream intent.",
            files: [{ path: "SKILL.md", content: mergedContents, reason: "Both changed." }],
          });
        },
      });

      expect(merge.targets[0]?.conflict_files).toEqual(["SKILL.md"]);
      expect(merge.targets[0]?.merged_diff).toContain("New upstream, locally tailored");
      expect(readFileSync(join(fixture.packagePath, "SKILL.md"), "utf8")).toBe(localContents);

      const receipt = await applyPreparedSkillSourceMerge(merge.merge_id, fixture.options);
      expect(receipt.strategy).toBe("agent_merge");
      expect(receipt.status).toBe("applied");
      expect(readFileSync(join(fixture.packagePath, "SKILL.md"), "utf8")).toBe(mergedContents);
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
