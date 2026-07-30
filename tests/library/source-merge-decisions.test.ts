import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, test } from "bun:test";

import {
  decideSourceMerge,
  getSourceMergeDecision,
  listSourceMergeDecisions,
  prepareSourceMergeDecision,
} from "../../packages/runtime/source-merge-decisions.js";
import type { GitHubTree } from "../../packages/runtime/skill-source-metadata.js";

function blobHash(contents: string): string {
  const bytes = Buffer.from(contents);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function folderTree(sha: string, contents: string): GitHubTree {
  return { sha, tree: [{ path: "SKILL.md", type: "blob", sha: blobHash(contents) }] };
}

function createFixture(now = "2026-07-16T10:00:00.000Z") {
  const root = mkdtempSync(join(tmpdir(), "selftune-source-decision-"));
  const packagePath = join(root, ".agents", "skills", "research");
  const lockPath = join(root, ".agents", ".skill-lock.json");
  const configRoot = join(root, ".selftune");
  const oldContents = "---\nname: research\ndescription: Old.\n---\n";
  const newContents = "---\nname: research\ndescription: New.\n---\n";
  const localContents = "---\nname: research\ndescription: Locally tailored.\n---\n";
  const mergedContents = "---\nname: research\ndescription: New and locally tailored.\n---\n";
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(packagePath, "SKILL.md"), localContents);
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
  const archive = (name: string, contents: string): string => {
    const sourceRoot = join(root, `archive-${name}`);
    const archiveRoot = join(sourceRoot, "example-skills", "skills", "research");
    mkdirSync(archiveRoot, { recursive: true });
    writeFileSync(join(archiveRoot, "SKILL.md"), contents);
    const path = join(root, `${name}.tar.gz`);
    const result = spawnSync("tar", ["czf", path, "-C", sourceRoot, "example-skills"]);
    if (result.status !== 0) throw new Error("Could not create fixture archive.");
    return path;
  };
  const oldArchive = archive("old", oldContents);
  const newArchive = archive("new", newContents);
  const options = {
    homeDir: root,
    configRoot,
    searchDirs: [join(root, ".agents", "skills")],
    now: Date.parse(now),
    decisionExpiryMs: 60_000,
    githubTreeLoader: async (_source: string, ref: string | null): Promise<GitHubTree | null> => {
      if (ref === "old-tree") return folderTree("old-tree", oldContents);
      if (ref === "new-tree") return folderTree("new-tree", newContents);
      return { sha: "root", tree: [{ path: "skills/research", type: "tree", sha: "new-tree" }] };
    },
    githubBlobLoader: async (_source: string, sha: string) => {
      if (sha === blobHash(oldContents)) return Buffer.from(oldContents);
      if (sha === blobHash(newContents)) return Buffer.from(newContents);
      return null;
    },
    archiveLoader: async (_source: string, ref: string | null) =>
      readFileSync(ref === "old-tree" ? oldArchive : newArchive),
    agentCaller: async () =>
      JSON.stringify({
        summary: "Preserved both intents.",
        files: [{ path: "SKILL.md", content: mergedContents, reason: "Both changed." }],
      }),
  };
  return { root, packagePath, mergedContents, localContents, options };
}

async function prepare(fixture: ReturnType<typeof createFixture>) {
  return prepareSourceMergeDecision(
    { skillName: "research", harnessId: "codex", agent: "codex", model: "gpt-test" },
    fixture.options,
  );
}

describe("durable source merge decisions", () => {
  test("persists a restart-safe typed pending decision with review fingerprints and audit data", async () => {
    const fixture = createFixture();
    try {
      const prepared = await prepare(fixture);
      const reloaded = getSourceMergeDecision(prepared.approval_id, fixture.options);

      expect(reloaded.status).toBe("pending");
      expect(reloaded.approval_id).toBe(prepared.preview.merge_id);
      expect(reloaded.harness_id).toBe("codex");
      expect(reloaded.model).toBe("gpt-test");
      expect(reloaded.targets[0]?.local_fingerprint).toHaveLength(64);
      expect(reloaded.targets[0]?.candidate_fingerprint).toHaveLength(64);
      expect(reloaded.targets[0]?.merged_diff).toContain("New and locally tailored");
      expect(reloaded.audit.map((entry) => entry.event)).toEqual(["prepared"]);
      expect(listSourceMergeDecisions(fixture.options)).toHaveLength(1);
      expect(readFileSync(join(fixture.packagePath, "SKILL.md"), "utf8")).toBe(
        fixture.localContents,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("declines idempotently without mutating the installed package", async () => {
    const fixture = createFixture();
    try {
      const { approval_id } = await prepare(fixture);
      const declined = await decideSourceMerge(approval_id, "decline", fixture.options);
      const repeated = await decideSourceMerge(approval_id, "approve", fixture.options);

      expect(declined.status).toBe("declined");
      expect(repeated).toEqual(declined);
      expect(readFileSync(join(fixture.packagePath, "SKILL.md"), "utf8")).toBe(
        fixture.localContents,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("approves once after revalidation and returns the same receipt on resume", async () => {
    const fixture = createFixture();
    try {
      const { approval_id } = await prepare(fixture);
      const [approved, resumed] = await Promise.all([
        decideSourceMerge(approval_id, "approve", fixture.options),
        decideSourceMerge(approval_id, "approve", fixture.options),
      ]);

      expect(approved.status).toBe("approved");
      expect(approved.receipt?.status).toBe("applied");
      expect(resumed.receipt?.receipt_id).toBe(approved.receipt?.receipt_id);
      expect(approved.audit.map((entry) => entry.event)).toEqual(["prepared", "approved"]);
      expect(readFileSync(join(fixture.packagePath, "SKILL.md"), "utf8")).toBe(
        fixture.mergedContents,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("records stale and expired outcomes without applying and points to fresh preparation", async () => {
    const staleFixture = createFixture();
    try {
      const { approval_id } = await prepare(staleFixture);
      writeFileSync(
        join(staleFixture.packagePath, "SKILL.md"),
        `${staleFixture.localContents}\nchanged`,
      );
      const stale = await decideSourceMerge(approval_id, "approve", staleFixture.options);
      expect(stale.status).toBe("stale");
      expect(stale.failure?.code).toBe("MERGE_STALE");
      expect(stale.failure?.message).toContain("Prepare");
    } finally {
      rmSync(staleFixture.root, { recursive: true, force: true });
    }

    const expiredFixture = createFixture();
    try {
      const { approval_id } = await prepare(expiredFixture);
      const expired = await decideSourceMerge(approval_id, "approve", {
        ...expiredFixture.options,
        now: expiredFixture.options.now + 60_001,
      });
      expect(expired.status).toBe("expired");
      expect(expired.failure?.code).toBe("APPROVAL_EXPIRED");
      expect(expired.failure?.message).toContain("fresh candidate");
      expect(readFileSync(join(expiredFixture.packagePath, "SKILL.md"), "utf8")).toBe(
        expiredFixture.localContents,
      );
    } finally {
      rmSync(expiredFixture.root, { recursive: true, force: true });
    }
  });

  test("serializes racing approve and decline requests into one terminal outcome", async () => {
    const fixture = createFixture();
    try {
      const { approval_id } = await prepare(fixture);
      const [first, second] = await Promise.all([
        decideSourceMerge(approval_id, "approve", fixture.options),
        decideSourceMerge(approval_id, "decline", fixture.options),
      ]);

      expect(first.status).toBe(second.status);
      expect(["approved", "declined"]).toContain(first.status);
      expect(first.audit).toHaveLength(2);
      expect(second.receipt?.receipt_id ?? null).toBe(first.receipt?.receipt_id ?? null);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
