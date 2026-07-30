import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  decideRemoval,
  getRemovalDecision,
  prepareRemovalDecision,
} from "../../packages/runtime/removal-decisions.js";
import type { InstalledSkillPackage } from "../../packages/runtime/utils/skill-discovery.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-removal-decision-"));
  const packagePath = join(root, ".agents", "skills", "research");
  const skillPath = join(packagePath, "SKILL.md");
  const configRoot = join(root, ".selftune");
  const quarantineRoot = join(configRoot, "quarantine");
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(skillPath, "---\nname: research\ndescription: Research.\n---\n");
  const installed: InstalledSkillPackage = {
    name: "research",
    skill_path: skillPath,
    package_path: packagePath,
    registry_dir: join(root, ".agents", "skills"),
    modified_at: "2026-07-16T10:00:00.000Z",
    skill_scope: "global",
  };
  const options = {
    configRoot,
    quarantineRoot,
    installedSkills: [installed],
    now: Date.parse("2026-07-16T10:00:00.000Z"),
    decisionExpiryMs: 60_000,
  };
  return { root, packagePath, skillPath, options };
}

describe("durable skill removal decisions", () => {
  test("shows every impact and declines without changing installed content", async () => {
    const value = fixture();
    try {
      const prepared = prepareRemovalDecision(
        { skillName: "research", locations: [{ skillPath: value.skillPath, connection: "Codex" }] },
        value.options,
      );
      const reloaded = getRemovalDecision(prepared.approval_id, value.options);
      expect(reloaded.locations[0]).toMatchObject({
        connection: "Codex",
        original_package_path: value.packagePath,
      });
      expect(reloaded.locations[0]?.archive_destination).toContain("quarantine");
      expect(reloaded.locations[0]?.recovery).toContain("Restore");

      const declined = await decideRemoval(prepared.approval_id, "decline", value.options);
      expect(declined.status).toBe("declined");
      expect(readFileSync(value.skillPath, "utf8")).toContain("Research");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("approves once with recovery receipts and resumes after restart", async () => {
    const value = fixture();
    try {
      const prepared = prepareRemovalDecision(
        { skillName: "research", locations: [{ skillPath: value.skillPath, connection: "Codex" }] },
        value.options,
      );
      const approved = await decideRemoval(prepared.approval_id, "approve", value.options);
      const resumed = await decideRemoval(prepared.approval_id, "approve", value.options);
      expect(approved.status).toBe("approved");
      expect(approved.receipt?.quarantines[0]?.undo_command).toContain("restore");
      expect(resumed).toEqual(approved);
      expect(approved.audit.map((entry) => entry.event)).toEqual(["prepared", "approved"]);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("returns stale and expired outcomes without moving changed content", async () => {
    const value = fixture();
    try {
      const prepared = prepareRemovalDecision(
        { skillName: "research", locations: [{ skillPath: value.skillPath, connection: null }] },
        value.options,
      );
      writeFileSync(value.skillPath, "---\nname: research\ndescription: Changed.\n---\n");
      const stale = await decideRemoval(prepared.approval_id, "approve", value.options);
      expect(stale.status).toBe("stale");
      expect(stale.failure?.code).toBe("REMOVAL_STALE");
      expect(readFileSync(value.skillPath, "utf8")).toContain("Changed");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }

    const expired = fixture();
    try {
      const prepared = prepareRemovalDecision(
        { skillName: "research", locations: [{ skillPath: expired.skillPath, connection: null }] },
        expired.options,
      );
      const result = await decideRemoval(prepared.approval_id, "approve", {
        ...expired.options,
        now: expired.options.now + 60_001,
      });
      expect(result.status).toBe("expired");
      expect(readFileSync(expired.skillPath, "utf8")).toContain("Research");
    } finally {
      rmSync(expired.root, { recursive: true, force: true });
    }
  });
});
