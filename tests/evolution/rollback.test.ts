/**
 * Tests for evolution rollback mechanism (TASK-15).
 *
 * Verifies that rollback restores SKILL.md to pre-evolution state,
 * records audit trail entries, handles missing proposals gracefully,
 * and supports both backup-file and audit-trail restoration strategies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../cli/selftune/evolution/audit.js";
import { rollback } from "../../cli/selftune/evolution/rollback.js";
import type { EvolutionAuditEntry } from "../../cli/selftune/types.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAuditEntry(overrides: Partial<EvolutionAuditEntry> = {}): EvolutionAuditEntry {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    proposal_id: "evo-test-001",
    action: "created",
    details: "Proposal created for test-skill evolution",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let logPath: string;
let skillDir: string;
let skillPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-rollback-test-"));
  logPath = join(tmpDir, "evolution_audit_log.jsonl");
  skillDir = join(tmpDir, "skills", "test-skill");
  mkdirSync(skillDir, { recursive: true });
  skillPath = join(skillDir, "SKILL.md");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Restores SKILL.md from backup file
// ---------------------------------------------------------------------------

describe("rollback from backup file", () => {
  test("restores SKILL.md from .bak file when it exists", async () => {
    const originalContent = "# Original Skill\nThis is the original description.";
    const evolvedContent = "# Evolved Skill\nThis is the evolved description.";

    // Write the evolved SKILL.md and the backup
    writeFileSync(skillPath, evolvedContent, "utf-8");
    writeFileSync(`${skillPath}.bak`, originalContent, "utf-8");

    // Seed audit trail with a deployed entry
    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "deployed",
        details: "Deployed proposal for test-skill evolution",
      }),
      logPath,
    );

    const result = await rollback({
      skillName: "test-skill",
      skillPath,
      logPath,
    });

    expect(result.rolledBack).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe(originalContent);
    expect(result.restoredDescription).toBe(originalContent);
  });

  test("removes .bak file after successful restore", async () => {
    const originalContent = "# Original content";
    const evolvedContent = "# Evolved content";

    writeFileSync(skillPath, evolvedContent, "utf-8");
    writeFileSync(`${skillPath}.bak`, originalContent, "utf-8");

    appendAuditEntry(
      makeAuditEntry({
        action: "deployed",
        details: "Deployed proposal for test-skill",
      }),
      logPath,
    );

    await rollback({ skillName: "test-skill", skillPath, logPath });

    expect(existsSync(`${skillPath}.bak`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Restores SKILL.md from audit trail details
// ---------------------------------------------------------------------------

describe("rollback from audit trail", () => {
  test("restores from audit trail created entry when no .bak exists", async () => {
    const originalDescription = "Original description from audit trail";
    const evolvedContent = "# Test Skill\n\nEvolved description\n\n## Config\nsome config\n";

    writeFileSync(skillPath, evolvedContent, "utf-8");

    // Seed audit trail: created entry stores original_description in details
    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "created",
        details: `original_description:${originalDescription}`,
      }),
      logPath,
    );
    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "deployed",
        details: "Deployed proposal for test-skill evolution",
      }),
      logPath,
    );

    const result = await rollback({
      skillName: "test-skill",
      skillPath,
      logPath,
    });

    expect(result.rolledBack).toBe(true);
    // Description section is replaced, but heading and subheading structure is preserved
    const restoredContent = readFileSync(skillPath, "utf-8");
    expect(restoredContent).toContain("# Test Skill");
    expect(restoredContent).toContain(originalDescription);
    expect(restoredContent).toContain("## Config");
    expect(restoredContent).not.toContain("Evolved description");
    expect(result.restoredDescription).toBe(originalDescription);
  });
});

// ---------------------------------------------------------------------------
// Audit trail records rollback
// ---------------------------------------------------------------------------

describe("audit trail recording", () => {
  test("appends a rolled_back entry to the audit trail", async () => {
    const originalContent = "# Original";
    const evolvedContent = "# Evolved";

    writeFileSync(skillPath, evolvedContent, "utf-8");
    writeFileSync(`${skillPath}.bak`, originalContent, "utf-8");

    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "deployed",
        details: "Deployed proposal for test-skill evolution",
      }),
      logPath,
    );

    await rollback({ skillName: "test-skill", skillPath, logPath });

    const entries = readJsonl<EvolutionAuditEntry>(logPath);
    const rollbackEntries = entries.filter((e) => e.action === "rolled_back");
    expect(rollbackEntries).toHaveLength(1);
    expect(rollbackEntries[0].proposal_id).toBe("evo-test-001");
    expect(rollbackEntries[0].action).toBe("rolled_back");
    expect(rollbackEntries[0].details).toContain("test-skill");
  });
});

// ---------------------------------------------------------------------------
// Handles no deployed proposal gracefully
// ---------------------------------------------------------------------------

describe("no deployed proposal", () => {
  test("returns rolledBack false when no deployed proposal exists", async () => {
    writeFileSync(skillPath, "# Some content", "utf-8");

    // Only a created entry, not deployed
    appendAuditEntry(
      makeAuditEntry({
        action: "created",
        details: "Created proposal for test-skill",
      }),
      logPath,
    );

    const result = await rollback({
      skillName: "test-skill",
      skillPath,
      logPath,
    });

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toContain("No deployed proposal");
    expect(result.restoredDescription).toBe("");
  });

  test("returns rolledBack false when audit trail is empty", async () => {
    writeFileSync(skillPath, "# Some content", "utf-8");

    const result = await rollback({
      skillName: "test-skill",
      skillPath,
      logPath,
    });

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toContain("No deployed proposal");
    expect(result.restoredDescription).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Rollback specific proposal by ID
// ---------------------------------------------------------------------------

describe("rollback specific proposal by ID", () => {
  test("rolls back a specific proposal when proposalId is provided", async () => {
    const originalDescription = "Original description for first proposal";
    const evolvedContent = "# Test Skill\n\nEvolved description\n\n## Config\nsome config\n";

    writeFileSync(skillPath, evolvedContent, "utf-8");
    writeFileSync(`${skillPath}.bak`, "# Should not be used for explicit proposalId", "utf-8");

    // Created entry with original_description for the target proposal
    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "created",
        details: `original_description:${originalDescription}`,
      }),
      logPath,
    );
    // Two deployed proposals
    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "deployed",
        details: "Deployed first proposal for test-skill",
      }),
      logPath,
    );
    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-002",
        action: "deployed",
        details: "Deployed second proposal for test-skill",
      }),
      logPath,
    );

    const result = await rollback({
      skillName: "test-skill",
      skillPath,
      proposalId: "evo-test-001",
      logPath,
    });

    expect(result.rolledBack).toBe(true);

    // .bak file should still exist (not consumed for explicit proposalId)
    expect(existsSync(`${skillPath}.bak`)).toBe(true);

    // Description should be replaced via audit trail, structure preserved
    const restoredContent = readFileSync(skillPath, "utf-8");
    expect(restoredContent).toContain(originalDescription);
    expect(restoredContent).toContain("## Config");
    expect(restoredContent).not.toContain("Evolved description");

    // Audit entry should reference the specific proposal ID
    const entries = readJsonl<EvolutionAuditEntry>(logPath);
    const rollbackEntries = entries.filter((e) => e.action === "rolled_back");
    expect(rollbackEntries[0].proposal_id).toBe("evo-test-001");
  });

  test("returns rolledBack false when specified proposalId not found in audit", async () => {
    writeFileSync(skillPath, "# Some content", "utf-8");

    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "deployed",
        details: "Deployed proposal for test-skill",
      }),
      logPath,
    );

    const result = await rollback({
      skillName: "test-skill",
      skillPath,
      proposalId: "evo-nonexistent-999",
      logPath,
    });

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toContain("not found");
    expect(result.restoredDescription).toBe("");
  });
});

// ---------------------------------------------------------------------------
// No restoration source available
// ---------------------------------------------------------------------------

describe("no restoration source", () => {
  test("returns rolledBack false when no .bak and no created entry in audit", async () => {
    writeFileSync(skillPath, "# Evolved content", "utf-8");

    // Deployed entry exists, but no "created" entry with original_description
    appendAuditEntry(
      makeAuditEntry({
        proposal_id: "evo-test-001",
        action: "deployed",
        details: "Deployed proposal for test-skill evolution",
      }),
      logPath,
    );

    const result = await rollback({
      skillName: "test-skill",
      skillPath,
      logPath,
    });

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toContain("No restoration source");
    expect(result.restoredDescription).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("SKILL.md does not exist at skillPath", async () => {
    const missingPath = join(skillDir, "MISSING_SKILL.md");

    appendAuditEntry(
      makeAuditEntry({
        action: "deployed",
        details: "Deployed proposal for test-skill",
      }),
      logPath,
    );

    const result = await rollback({
      skillName: "test-skill",
      skillPath: missingPath,
      logPath,
    });

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toContain("SKILL.md not found");
    expect(result.restoredDescription).toBe("");
  });
});
