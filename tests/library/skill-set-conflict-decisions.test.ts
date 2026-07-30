import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  decideSkillSetConflict,
  prepareSkillSetConflictDecision,
  rollbackSkillSetConflictDecision,
} from "../../packages/runtime/skill-set-conflict-decisions.js";
import { createSkillSet } from "../../packages/runtime/skill-sets.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-set-conflict-"));
  const configRoot = join(root, ".selftune");
  const source = join(root, "source", "tdd");
  const projectRoot = join(root, "project");
  const conflict = join(projectRoot, ".agents", "skills", "tdd");
  mkdirSync(source, { recursive: true });
  mkdirSync(conflict, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: tdd\ndescription: Pinned.\n---\n");
  writeFileSync(join(conflict, "SKILL.md"), "---\nname: tdd\ndescription: Project custom.\n---\n");
  const options = {
    configRoot,
    now: new Date("2026-07-16T10:00:00.000Z"),
    decisionExpiryMs: 60_000,
  };
  const set = createSkillSet(
    {
      name: "Software Development",
      description: "Engineering",
      harnesses: ["codex"],
      skills: [{ name: "tdd", package_path: source }],
    },
    options,
  );
  return { root, configRoot, projectRoot, conflict, set, options };
}

describe("durable Skill Set conflict decisions", () => {
  test("presents overwritten paths and declines without changing project content", async () => {
    const value = fixture();
    try {
      const prepared = prepareSkillSetConflictDecision(
        { skillSetId: value.set.set_id, projectRoot: value.projectRoot },
        value.options,
      );
      expect(prepared.conflicts).toBe(1);
      expect(prepared.impacts[0]?.target_path).toEndWith("/project/.agents/skills/tdd");
      expect(prepared.impacts[0]?.backup_path).toContain("recovery");
      expect(prepared.impacts[0]?.rollback).toContain("restore");
      const declined = await decideSkillSetConflict(prepared.approval_id, "decline", value.options);
      expect(declined.status).toBe("declined");
      expect(readFileSync(join(value.conflict, "SKILL.md"), "utf8")).toContain("Project custom");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("approves once, returns a recovery receipt, and restores overwritten content", async () => {
    const value = fixture();
    try {
      const prepared = prepareSkillSetConflictDecision(
        { skillSetId: value.set.set_id, projectRoot: value.projectRoot },
        value.options,
      );
      const approved = await decideSkillSetConflict(prepared.approval_id, "approve", value.options);
      const resumed = await decideSkillSetConflict(prepared.approval_id, "approve", value.options);
      expect(approved.status).toBe("approved");
      expect(approved.receipt?.skill_set_receipt.status).toBe("applied");
      expect(approved.receipt?.rollback_behavior).toContain("restores every overwritten package");
      expect(resumed).toEqual(approved);
      expect(readFileSync(join(value.conflict, "SKILL.md"), "utf8")).toContain("Pinned");

      const rolledBack = rollbackSkillSetConflictDecision(prepared.approval_id, value.options);
      expect(rolledBack.receipt?.status).toBe("rolled_back");
      expect(readFileSync(join(value.conflict, "SKILL.md"), "utf8")).toContain("Project custom");
      expect(rollbackSkillSetConflictDecision(prepared.approval_id, value.options)).toEqual(
        rolledBack,
      );
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("returns stale and expired without overwriting project content", async () => {
    const value = fixture();
    try {
      const prepared = prepareSkillSetConflictDecision(
        { skillSetId: value.set.set_id, projectRoot: value.projectRoot },
        value.options,
      );
      writeFileSync(
        join(value.conflict, "SKILL.md"),
        "---\nname: tdd\ndescription: New edit.\n---\n",
      );
      const stale = await decideSkillSetConflict(prepared.approval_id, "approve", value.options);
      expect(stale.status).toBe("stale");
      expect(readFileSync(join(value.conflict, "SKILL.md"), "utf8")).toContain("New edit");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }

    const expired = fixture();
    try {
      const prepared = prepareSkillSetConflictDecision(
        { skillSetId: expired.set.set_id, projectRoot: expired.projectRoot },
        expired.options,
      );
      const result = await decideSkillSetConflict(prepared.approval_id, "approve", {
        ...expired.options,
        now: new Date(expired.options.now.getTime() + 60_001),
      });
      expect(result.status).toBe("expired");
      expect(readFileSync(join(expired.conflict, "SKILL.md"), "utf8")).toContain("Project custom");
    } finally {
      rmSync(expired.root, { recursive: true, force: true });
    }
  });
});
