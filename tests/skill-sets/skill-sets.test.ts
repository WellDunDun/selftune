import { describe, expect, test } from "bun:test";
import {
  existsSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applySkillSet,
  createSkillSet,
  deriveSkillSetFromProject,
  exportPortableSkillSet,
  importPortableSkillSet,
  listSkillSetRevisions,
  planSkillSet,
  rollbackSkillSet,
  updateSkillSet,
} from "../../packages/runtime/skill-sets.js";

function createSkill(root: string, name: string): string {
  const packagePath = join(root, name);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`,
  );
  writeFileSync(join(packagePath, "reference.md"), `Reference for ${name}.\n`);
  return packagePath;
}

describe("project Skill Sets", () => {
  test("records immutable revisions and round-trips a portable repository manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-revisions-"));
    try {
      const configRoot = join(root, "config-a");
      const research = createSkill(join(root, "installed"), "research");
      const review = createSkill(join(root, "installed"), "review");
      const first = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: research }],
        },
        { configRoot },
      );
      const second = updateSkillSet(
        first.set_id,
        {
          harnesses: ["codex", "opencode"],
          skills: [
            { name: "research", package_path: research },
            { name: "review", package_path: review },
          ],
          parent_revision_hash: first.revision_hash,
        },
        { configRoot },
      );
      expect(first.revision).toBe(1);
      expect(second.revision).toBe(2);
      expect(second.parent_revision_hash).toBe(first.revision_hash);
      expect(listSkillSetRevisions(first.set_id, { configRoot })).toHaveLength(2);
      expect(() =>
        updateSkillSet(
          first.set_id,
          {
            harnesses: ["codex"],
            skills: [{ name: "research", package_path: research }],
            parent_revision_hash: first.revision_hash,
          },
          { configRoot },
        ),
      ).toThrow(/changed after this edit started/);

      const projectRoot = join(root, "repository");
      mkdirSync(projectRoot);
      const portablePath = exportPortableSkillSet(second.set_id, projectRoot, { configRoot });
      const portableText = readFileSync(portablePath, "utf8");
      expect(portableText).not.toContain(configRoot);
      expect(portableText).not.toContain("library_package_path");

      const cleanRoot = join(root, "config-b");
      cpSync(join(configRoot, "library", "packages"), join(cleanRoot, "library", "packages"), {
        recursive: true,
      });
      const imported = importPortableSkillSet(portablePath, { configRoot: cleanRoot });
      expect(imported.revision_hash).toBe(second.revision_hash);
      expect(imported.skills).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives a deduplicated Skill Set from active project harness registries", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-derive-"));
    try {
      const projectRoot = join(root, "project");
      const research = createSkill(join(projectRoot, ".agents", "skills"), "research");
      mkdirSync(join(projectRoot, ".opencode", "skills"), { recursive: true });
      symlinkSync(research, join(projectRoot, ".opencode", "skills", "research"), "dir");
      const derived = deriveSkillSetFromProject(
        {
          name: "Captured project",
          project_root: projectRoot,
          harnesses: ["codex", "opencode"],
        },
        { configRoot: join(root, "config") },
      );
      expect(derived.skills).toHaveLength(1);
      expect(derived.skills[0]?.name).toBe("research");
      expect(derived.harnesses).toEqual(["codex", "opencode"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("caches immutable packages and previews project links without mutating the project", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const packagePath = createSkill(join(root, "installed"), "research");

      const manifest = createSkillSet(
        {
          name: "Research project",
          description: "Skills used for evidence-heavy research projects.",
          harnesses: ["codex", "claude_code"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot },
      );
      const plan = planSkillSet(
        { set_id: manifest.set_id, project_root: projectRoot },
        { configRoot },
      );

      expect(manifest.skills).toHaveLength(1);
      expect(manifest.skills[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(manifest.skills[0]!.library_package_path)).toBe(true);
      expect(plan.conflicts).toBe(0);
      expect(plan.operations.map((operation) => operation.action)).toEqual(["create", "create"]);
      expect(plan.operations.map((operation) => operation.target_path)).toEqual([
        join(realpathSync(projectRoot), ".agents", "skills", "research"),
        join(realpathSync(projectRoot), ".claude", "skills", "research"),
      ]);
      expect(existsSync(join(projectRoot, ".agents"))).toBe(false);
      expect(existsSync(join(projectRoot, ".claude"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializes every supported harness through normalized target adapters", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-harnesses-"));
    try {
      const configRoot = join(root, "config");
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const packagePath = createSkill(join(root, "installed"), "research");
      const manifest = createSkillSet(
        {
          name: "All harnesses",
          harnesses: ["codex", "claude_code", "opencode", "openclaw", "pi"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot },
      );
      const plan = planSkillSet(
        { set_id: manifest.set_id, project_root: projectRoot },
        { configRoot },
      );
      expect(plan.operations.map((operation) => operation.target_path)).toEqual([
        join(realpathSync(projectRoot), ".agents", "skills", "research"),
        join(realpathSync(projectRoot), ".claude", "skills", "research"),
        join(realpathSync(projectRoot), ".opencode", "skills", "research"),
        join(realpathSync(projectRoot), ".openclaw", "skills", "research"),
        join(realpathSync(projectRoot), ".pi", "agent", "skills", "research"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("applies idempotently and rolls back only receipt-owned paths", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const packagePath = createSkill(join(root, "installed"), "research");
      const manifest = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot },
      );

      const applied = applySkillSet(
        { set_id: manifest.set_id, project_root: projectRoot },
        { configRoot },
      );
      const targetPath = join(projectRoot, ".agents", "skills", "research");
      expect(applied.status).toBe("applied");
      expect(applied.operations).toHaveLength(1);
      expect(Object.keys(applied.operations[0]!).toSorted()).toEqual([
        "content_hash",
        "harness",
        "skill_name",
        "source_path",
        "state",
        "strategy",
        "target_ctime_ns",
        "target_device",
        "target_inode",
        "target_path",
      ]);
      expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);

      const repeated = applySkillSet(
        { set_id: manifest.set_id, project_root: projectRoot },
        { configRoot },
      );
      expect(repeated.status).toBe("unchanged");
      expect(repeated.operations).toHaveLength(0);

      const rolledBack = rollbackSkillSet(applied.receipt_id, { configRoot });
      expect(rolledBack.status).toBe("rolled_back");
      expect(existsSync(targetPath)).toBe(false);
      expect(existsSync(manifest.skills[0]!.library_package_path)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks all mutations when any destination contains a different revision", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const installedRoot = join(root, "installed");
      const researchPath = createSkill(installedRoot, "research");
      const reviewPath = createSkill(installedRoot, "review");
      const manifest = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [
            { name: "research", package_path: researchPath },
            { name: "review", package_path: reviewPath },
          ],
        },
        { configRoot },
      );
      createSkill(join(projectRoot, ".agents", "skills"), "review");
      writeFileSync(join(projectRoot, ".agents", "skills", "review", "local.txt"), "different\n");

      const plan = planSkillSet(
        { set_id: manifest.set_id, project_root: projectRoot },
        { configRoot },
      );
      expect(plan.conflicts).toBe(1);
      expect(() =>
        applySkillSet({ set_id: manifest.set_id, project_root: projectRoot }, { configRoot }),
      ).toThrow("blocked by 1 destination conflict");
      expect(existsSync(join(projectRoot, ".agents", "skills", "research"))).toBe(false);
      expect(existsSync(join(projectRoot, ".agents", "skills", "review", "local.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not roll back a replacement that reuses the recorded device and inode", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const projectRoot = join(root, "project");
      mkdirSync(projectRoot);
      const packagePath = createSkill(join(root, "installed"), "research");
      const manifest = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot },
      );
      const receipt = applySkillSet(
        { set_id: manifest.set_id, project_root: projectRoot },
        { configRoot },
      );
      const targetPath = join(projectRoot, ".agents", "skills", "research");
      const originalIdentity = lstatSync(targetPath, { bigint: true });

      rmSync(targetPath);
      symlinkSync(manifest.skills[0]!.library_package_path, targetPath, "dir");
      const replacementIdentity = lstatSync(targetPath, { bigint: true });
      expect(replacementIdentity.ctimeNs).not.toBe(originalIdentity.ctimeNs);
      writeFileSync(
        join(configRoot, "skill-set-receipts", `${receipt.receipt_id}.json`),
        `${JSON.stringify(
          {
            ...receipt,
            operations: receipt.operations.map((operation) => ({
              ...operation,
              target_device: replacementIdentity.dev.toString(),
              target_inode: replacementIdentity.ino.toString(),
              target_ctime_ns: originalIdentity.ctimeNs.toString(),
            })),
          },
          null,
          2,
        )}\n`,
      );

      expect(() => rollbackSkillSet(receipt.receipt_id, { configRoot })).toThrow(
        "Rollback target was replaced",
      );
      expect(existsSync(join(targetPath, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an empty or missing project root before planning", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const packagePath = createSkill(join(root, "installed"), "research");
      const manifest = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot },
      );

      expect(() =>
        planSkillSet({ set_id: manifest.set_id, project_root: "" }, { configRoot }),
      ).toThrow("Project root is required");
      expect(() =>
        planSkillSet(
          { set_id: manifest.set_id, project_root: join(root, "missing") },
          { configRoot },
        ),
      ).toThrow("Project directory was not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks project registry links that redirect outside the project", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const projectRoot = join(root, "project");
      const externalRoot = join(root, "external");
      mkdirSync(projectRoot);
      mkdirSync(externalRoot);
      symlinkSync(externalRoot, join(projectRoot, ".agents"), "dir");
      const packagePath = createSkill(join(root, "installed"), "research");
      const manifest = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot },
      );

      expect(() =>
        planSkillSet({ set_id: manifest.set_id, project_root: projectRoot }, { configRoot }),
      ).toThrow("redirected outside the project");
      expect(existsSync(join(externalRoot, "skills"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects package-internal symlinks from immutable Library revisions", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const packagePath = createSkill(join(root, "installed"), "research");
      const externalReference = join(root, "mutable-reference.md");
      writeFileSync(externalReference, "Mutable reference.\n");
      symlinkSync(externalReference, join(packagePath, "linked-reference.md"));

      expect(() =>
        createSkillSet(
          {
            name: "Research project",
            harnesses: ["codex"],
            skills: [{ name: "research", package_path: packagePath }],
          },
          { configRoot },
        ),
      ).toThrow("contains a symbolic link");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rolls back a pending receipt left between mutation checkpoints", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-skill-set-"));
    try {
      const configRoot = join(root, "config");
      const projectRoot = realpathSync(root);
      const packagePath = createSkill(join(root, "installed"), "research");
      const manifest = createSkillSet(
        {
          name: "Research project",
          harnesses: ["codex"],
          skills: [{ name: "research", package_path: packagePath }],
        },
        { configRoot },
      );
      const targetPath = join(projectRoot, ".agents", "skills", "research");
      mkdirSync(join(projectRoot, ".agents", "skills"), { recursive: true });
      symlinkSync(manifest.skills[0]!.library_package_path, targetPath, "dir");
      const receiptId = "interrupted-apply";
      const receiptDirectory = join(configRoot, "skill-set-receipts");
      mkdirSync(receiptDirectory, { recursive: true });
      writeFileSync(
        join(receiptDirectory, `${receiptId}.json`),
        JSON.stringify({
          schema_version: 1,
          receipt_id: receiptId,
          set_id: manifest.set_id,
          set_name: manifest.name,
          project_root: projectRoot,
          status: "applying",
          operations: [
            {
              harness: "codex",
              skill_name: "research",
              content_hash: manifest.skills[0]!.content_hash,
              source_path: manifest.skills[0]!.library_package_path,
              target_path: targetPath,
              strategy: null,
              state: "pending",
            },
          ],
          applied_at: "2026-07-14T00:00:00.000Z",
          rolled_back_at: null,
        }),
      );

      const rolledBack = rollbackSkillSet(receiptId, { configRoot });
      expect(rolledBack.status).toBe("rolled_back");
      expect(existsSync(targetPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
