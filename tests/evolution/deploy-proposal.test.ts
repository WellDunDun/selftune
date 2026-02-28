/**
 * Tests for evolution deploy-proposal (TASK-14).
 *
 * Verifies SKILL.md reading, description replacement, commit message
 * building, and the full deployProposal pipeline including backup,
 * branch creation, and PR generation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValidationResult } from "../../cli/selftune/evolution/validate-proposal.js";
import type { EvolutionProposal } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

const { readSkillMd, replaceDescription, buildCommitMessage, deployProposal } = await import(
  "../../cli/selftune/evolution/deploy-proposal.js"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SKILL_MD = `# My Skill

This is the original skill description that explains
what the skill does and when it should be triggered.

## Configuration

Some config details here.

## Examples

- Example 1
- Example 2
`;

const SAMPLE_SKILL_MD_NO_H2 = `# My Skill

This is the entire file description with no sub-headings.
`;

function makeProposal(overrides: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    proposal_id: "evo-test-001",
    skill_name: "test-skill",
    skill_path: "/skills/test-skill/SKILL.md",
    original_description:
      "This is the original skill description that explains\nwhat the skill does and when it should be triggered.",
    proposed_description:
      "This is the improved skill description that better covers edge cases and routing.",
    rationale: "Expanded coverage for missed queries about routing",
    failure_patterns: ["fp-test-0"],
    eval_results: {
      before: { total: 20, passed: 14, failed: 6, pass_rate: 0.7 },
      after: { total: 20, passed: 17, failed: 3, pass_rate: 0.85 },
    },
    confidence: 0.82,
    created_at: "2026-02-28T12:00:00Z",
    status: "validated",
    ...overrides,
  };
}

function makeValidation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    proposal_id: "evo-test-001",
    before_pass_rate: 0.7,
    after_pass_rate: 0.85,
    improved: true,
    regressions: [],
    new_passes: [{ query: "new pass query", should_trigger: true }],
    net_change: 0.15,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-deploy-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readSkillMd
// ---------------------------------------------------------------------------

describe("readSkillMd", () => {
  test("reads content from an existing SKILL.md file", () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const content = readSkillMd(skillPath);
    expect(content).toBe(SAMPLE_SKILL_MD);
  });

  test("throws when SKILL.md does not exist", () => {
    const missingPath = join(tmpDir, "missing", "SKILL.md");
    expect(() => readSkillMd(missingPath)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// replaceDescription
// ---------------------------------------------------------------------------

describe("replaceDescription", () => {
  test("replaces description between first heading and first ## heading", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "New improved description.");

    expect(result).toContain("# My Skill");
    expect(result).toContain("New improved description.");
    expect(result).toContain("## Configuration");
    expect(result).toContain("## Examples");
    expect(result).not.toContain("original skill description");
  });

  test("preserves the first heading exactly", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "Updated desc.");
    const lines = result.split("\n");
    expect(lines[0]).toBe("# My Skill");
  });

  test("preserves everything after the first ## heading", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "New desc.");

    // Everything from ## Configuration onward should be unchanged
    const configIndex = result.indexOf("## Configuration");
    expect(configIndex).toBeGreaterThan(0);
    const afterConfig = result.slice(configIndex);
    const originalAfterConfig = SAMPLE_SKILL_MD.slice(SAMPLE_SKILL_MD.indexOf("## Configuration"));
    expect(afterConfig).toBe(originalAfterConfig);
  });

  test("handles SKILL.md with no ## sub-headings (replaces entire body)", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD_NO_H2, "Replaced everything.");

    expect(result).toContain("# My Skill");
    expect(result).toContain("Replaced everything.");
    expect(result).not.toContain("entire file description");
  });

  test("handles empty description replacement", () => {
    const result = replaceDescription(SAMPLE_SKILL_MD, "");

    expect(result).toContain("# My Skill");
    expect(result).toContain("## Configuration");
  });
});

// ---------------------------------------------------------------------------
// buildCommitMessage
// ---------------------------------------------------------------------------

describe("buildCommitMessage", () => {
  test("includes skill name in commit message", () => {
    const proposal = makeProposal();
    const validation = makeValidation();
    const msg = buildCommitMessage(proposal, validation);

    expect(msg).toContain("test-skill");
  });

  test("includes pass rate change as percentage", () => {
    const proposal = makeProposal();
    const validation = makeValidation({ before_pass_rate: 0.7, after_pass_rate: 0.85 });
    const msg = buildCommitMessage(proposal, validation);

    // Should contain "+15%" (0.85 - 0.70 = 0.15 = 15%)
    expect(msg).toContain("+15%");
  });

  test("includes negative pass rate change when regression", () => {
    const proposal = makeProposal();
    const validation = makeValidation({
      before_pass_rate: 0.85,
      after_pass_rate: 0.7,
      net_change: -0.15,
    });
    const msg = buildCommitMessage(proposal, validation);

    expect(msg).toContain("-15%");
  });

  test("follows evolve(skill) commit format", () => {
    const proposal = makeProposal({ skill_name: "pptx" });
    const validation = makeValidation();
    const msg = buildCommitMessage(proposal, validation);

    expect(msg).toMatch(/^evolve\(pptx\):/);
  });
});

// ---------------------------------------------------------------------------
// deployProposal - backup
// ---------------------------------------------------------------------------

describe("deployProposal - backup", () => {
  test("creates a .bak backup of the original SKILL.md", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const result = await deployProposal({
      proposal: makeProposal(),
      validation: makeValidation(),
      skillPath,
      createPr: false,
    });

    expect(result.backupPath).not.toBeNull();
    const backupPath = result.backupPath ?? "";
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf-8")).toBe(SAMPLE_SKILL_MD);
  });

  test("backup path ends with .bak", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const result = await deployProposal({
      proposal: makeProposal(),
      validation: makeValidation(),
      skillPath,
      createPr: false,
    });

    expect(result.backupPath).toMatch(/\.bak$/);
  });
});

// ---------------------------------------------------------------------------
// deployProposal - SKILL.md update
// ---------------------------------------------------------------------------

describe("deployProposal - SKILL.md update", () => {
  test("writes the proposed description into SKILL.md", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const proposal = makeProposal({
      proposed_description: "A brand new improved description.",
    });

    await deployProposal({
      proposal,
      validation: makeValidation(),
      skillPath,
      createPr: false,
    });

    const updated = readFileSync(skillPath, "utf-8");
    expect(updated).toContain("A brand new improved description.");
    expect(updated).not.toContain("original skill description");
  });

  test("returns skillMdUpdated as true on success", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const result = await deployProposal({
      proposal: makeProposal(),
      validation: makeValidation(),
      skillPath,
      createPr: false,
    });

    expect(result.skillMdUpdated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deployProposal - commit message
// ---------------------------------------------------------------------------

describe("deployProposal - commit message", () => {
  test("result includes formatted commit message with metrics", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const result = await deployProposal({
      proposal: makeProposal({ skill_name: "router" }),
      validation: makeValidation({ before_pass_rate: 0.6, after_pass_rate: 0.8, net_change: 0.2 }),
      skillPath,
      createPr: false,
    });

    expect(result.commitMessage).toMatch(/^evolve\(router\):/);
    expect(result.commitMessage).toContain("+20%");
  });
});

// ---------------------------------------------------------------------------
// deployProposal - no PR mode
// ---------------------------------------------------------------------------

describe("deployProposal - no PR mode", () => {
  test("branchName is null when createPr is false", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const result = await deployProposal({
      proposal: makeProposal(),
      validation: makeValidation(),
      skillPath,
      createPr: false,
    });

    expect(result.branchName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deployProposal - PR mode (mocked git/gh)
// ---------------------------------------------------------------------------

describe("deployProposal - PR mode", () => {
  test("generates a branch name with the default prefix", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const result = await deployProposal({
      proposal: makeProposal({ skill_name: "test-skill" }),
      validation: makeValidation(),
      skillPath,
      createPr: true,
    });

    // Branch name should use the default prefix
    expect(result.branchName).not.toBeNull();
    const branch = result.branchName ?? "";
    expect(branch.startsWith("selftune/evolve")).toBe(true);
    expect(branch).toContain("test-skill");
  });

  test("uses custom branchPrefix when provided", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const result = await deployProposal({
      proposal: makeProposal({ skill_name: "router" }),
      validation: makeValidation(),
      skillPath,
      createPr: true,
      branchPrefix: "custom/prefix",
    });

    const branch = result.branchName ?? "";
    expect(branch.startsWith("custom/prefix")).toBe(true);
    expect(branch).toContain("router");
  });
});
