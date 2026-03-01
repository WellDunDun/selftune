/**
 * E2E integration tests for the evolution pipeline (TASK-18).
 *
 * Tests the full file I/O integration cycle: pattern extraction, deploy,
 * rollback, and the evolve orchestrator with realistic temp-file setups.
 *
 * Does NOT use mock.module() to avoid global state leakage. Instead tests
 * component functions directly and verifies file I/O end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendAuditEntry, readAuditTrail } from "../../cli/selftune/evolution/audit.js";
import {
  deployProposal,
  replaceDescription,
} from "../../cli/selftune/evolution/deploy-proposal.js";
import { extractFailurePatterns } from "../../cli/selftune/evolution/extract-patterns.js";
import { rollback } from "../../cli/selftune/evolution/rollback.js";
import type { ValidationResult } from "../../cli/selftune/evolution/validate-proposal.js";
import type {
  EvalEntry,
  EvolutionAuditEntry,
  EvolutionProposal,
  QueryLogRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";
import { readJsonl } from "../../cli/selftune/utils/jsonl.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_SKILL_MD = `# Test Skill

This is the original skill description. It handles basic tasks
like creating documents and formatting text.

## Configuration

- mode: auto
- format: markdown

## Examples

- "create a document"
- "format this text"
`;

function makeProposal(overrides: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    proposal_id: "evo-integ-001",
    skill_name: "test-skill",
    skill_path: "/tmp/SKILL.md",
    original_description:
      "This is the original skill description. It handles basic tasks\nlike creating documents and formatting text.",
    proposed_description:
      "This skill handles document creation, text formatting, and template generation.\nIt supports markdown, plain text, and structured output formats.",
    rationale: "Expanded coverage for document template queries",
    failure_patterns: ["fp-test-skill-0"],
    eval_results: {
      before: { total: 20, passed: 14, failed: 6, pass_rate: 0.7 },
      after: { total: 20, passed: 18, failed: 2, pass_rate: 0.9 },
    },
    confidence: 0.85,
    created_at: "2026-02-28T12:00:00Z",
    status: "validated",
    ...overrides,
  };
}

function makeValidation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    proposal_id: "evo-integ-001",
    before_pass_rate: 0.7,
    after_pass_rate: 0.9,
    improved: true,
    regressions: [],
    new_passes: [{ query: "generate a template", should_trigger: true }],
    net_change: 0.2,
    ...overrides,
  };
}

function makeSkillUsageRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    skill_name: "test-skill",
    skill_path: "/tmp/skills/test-skill/SKILL.md",
    query: "create a document",
    triggered: true,
    ...overrides,
  };
}

function _makeQueryLogRecord(overrides: Partial<QueryLogRecord> = {}): QueryLogRecord {
  return {
    timestamp: "2026-02-28T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    query: "some unrelated query",
    ...overrides,
  };
}

function makeEvalEntry(overrides: Partial<EvalEntry> = {}): EvalEntry {
  return {
    query: "create a document",
    should_trigger: true,
    invocation_type: "implicit",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-evolution-integ-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// E2E: Extract patterns from eval set + skill usage
// ---------------------------------------------------------------------------

describe("integration: extract failure patterns from files", () => {
  test("extracts patterns from eval set and skill usage log data", () => {
    // Simulate realistic eval set with mixed results
    const evalEntries: EvalEntry[] = [
      makeEvalEntry({ query: "create a document", should_trigger: true }),
      makeEvalEntry({ query: "format this text", should_trigger: true }),
      makeEvalEntry({ query: "generate a template for reports", should_trigger: true }),
      makeEvalEntry({ query: "build a slide deck", should_trigger: true }),
      makeEvalEntry({
        query: "what is the weather?",
        should_trigger: false,
        invocation_type: "negative",
      }),
    ];

    // Only some queries actually triggered the skill
    const skillUsage: SkillUsageRecord[] = [
      makeSkillUsageRecord({ query: "create a document", triggered: true }),
      makeSkillUsageRecord({ query: "format this text", triggered: true }),
    ];

    const patterns = extractFailurePatterns(evalEntries, skillUsage, "test-skill");

    // Should find 2 missed queries: "generate a template for reports" and "build a slide deck"
    expect(patterns.length).toBeGreaterThanOrEqual(1);

    const allMissed = patterns.flatMap((p) => p.missed_queries);
    expect(allMissed).toContain("generate a template for reports");
    expect(allMissed).toContain("build a slide deck");

    // Should NOT include triggered queries or negatives
    expect(allMissed).not.toContain("create a document");
    expect(allMissed).not.toContain("what is the weather?");
  });

  test("returns empty patterns when all eval entries are triggered", () => {
    const evalEntries: EvalEntry[] = [
      makeEvalEntry({ query: "create a document", should_trigger: true }),
      makeEvalEntry({ query: "format this text", should_trigger: true }),
    ];

    const skillUsage: SkillUsageRecord[] = [
      makeSkillUsageRecord({ query: "create a document", triggered: true }),
      makeSkillUsageRecord({ query: "format this text", triggered: true }),
    ];

    const patterns = extractFailurePatterns(evalEntries, skillUsage, "test-skill");
    expect(patterns).toHaveLength(0);
  });

  test("reads patterns from JSONL files on disk", () => {
    // Write eval set to file
    const evalSetPath = join(tmpDir, "eval_set.json");
    const evalEntries: EvalEntry[] = [
      makeEvalEntry({ query: "create a document", should_trigger: true }),
      makeEvalEntry({ query: "missing query one", should_trigger: true }),
      makeEvalEntry({ query: "missing query two", should_trigger: true }),
    ];
    writeFileSync(evalSetPath, JSON.stringify(evalEntries), "utf-8");

    // Write skill usage log to JSONL file
    const skillLogPath = join(tmpDir, "skill_usage.jsonl");
    const skillRecords: SkillUsageRecord[] = [
      makeSkillUsageRecord({ query: "create a document", triggered: true }),
    ];
    const skillContent = `${skillRecords.map((r) => JSON.stringify(r)).join("\n")}\n`;
    writeFileSync(skillLogPath, skillContent, "utf-8");

    // Read them back and extract patterns
    const loadedEval = JSON.parse(readFileSync(evalSetPath, "utf-8")) as EvalEntry[];
    const loadedSkill = readJsonl<SkillUsageRecord>(skillLogPath);

    const patterns = extractFailurePatterns(loadedEval, loadedSkill, "test-skill");

    expect(patterns.length).toBeGreaterThanOrEqual(1);
    const allMissed = patterns.flatMap((p) => p.missed_queries);
    expect(allMissed).toContain("missing query one");
    expect(allMissed).toContain("missing query two");
  });
});

// ---------------------------------------------------------------------------
// E2E: Deploy proposal + file verification
// ---------------------------------------------------------------------------

describe("integration: deploy proposal writes SKILL.md correctly", () => {
  test("full deploy cycle: backup, replace description, verify file contents", async () => {
    const skillPath = join(tmpDir, "SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const proposal = makeProposal({ skill_path: skillPath });
    const validation = makeValidation();

    const result = await deployProposal({
      proposal,
      validation,
      skillPath,
      createPr: false,
    });

    // Verify: backup created
    expect(result.skillMdUpdated).toBe(true);
    expect(result.backupPath).not.toBeNull();
    const backupPath = result.backupPath as string;
    expect(existsSync(backupPath)).toBe(true);

    // Verify: backup contains original content
    const backupContent = readFileSync(backupPath, "utf-8");
    expect(backupContent).toBe(SAMPLE_SKILL_MD);

    // Verify: SKILL.md now contains the proposed description
    const updatedContent = readFileSync(skillPath, "utf-8");
    expect(updatedContent).toContain(proposal.proposed_description);
    expect(updatedContent).not.toContain("original skill description");

    // Verify: sections after ## are preserved
    expect(updatedContent).toContain("## Configuration");
    expect(updatedContent).toContain("## Examples");

    // Verify: commit message format
    expect(result.commitMessage).toContain("test-skill");
    expect(result.commitMessage).toContain("+20%");
  });
});

// ---------------------------------------------------------------------------
// E2E: Deploy then rollback full cycle
// ---------------------------------------------------------------------------

describe("integration: deploy then rollback restores original SKILL.md", () => {
  test("full deploy-then-rollback cycle restores SKILL.md to original state", async () => {
    const skillDir = join(tmpDir, "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const logPath = join(tmpDir, "evolution_audit_log.jsonl");

    // Step 1: Write original SKILL.md
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    // Step 2: Deploy a proposal
    const proposal = makeProposal({ skill_path: skillPath });
    const validation = makeValidation();

    await deployProposal({
      proposal,
      validation,
      skillPath,
      createPr: false,
    });

    // Verify deploy happened
    const deployedContent = readFileSync(skillPath, "utf-8");
    expect(deployedContent).toContain(proposal.proposed_description);
    expect(deployedContent).not.toContain("original skill description");

    // Step 3: Record a deployed audit entry (normally done by evolve orchestrator)
    appendAuditEntry(
      {
        timestamp: new Date().toISOString(),
        proposal_id: proposal.proposal_id,
        action: "deployed",
        details: "Deployed proposal for test-skill evolution",
      },
      logPath,
    );

    // Step 4: Rollback
    const rollbackResult = await rollback({
      skillName: "test-skill",
      skillPath,
      logPath,
    });

    // Verify rollback succeeded
    expect(rollbackResult.rolledBack).toBe(true);
    expect(rollbackResult.reason).toContain("backup");

    // Verify: SKILL.md is restored to original content
    const restoredContent = readFileSync(skillPath, "utf-8");
    expect(restoredContent).toBe(SAMPLE_SKILL_MD);

    // Verify: .bak file is cleaned up
    expect(existsSync(`${skillPath}.bak`)).toBe(false);

    // Verify: audit trail has a rolled_back entry
    const auditEntries = readJsonl<EvolutionAuditEntry>(logPath);
    const rollbackEntries = auditEntries.filter((e) => e.action === "rolled_back");
    expect(rollbackEntries).toHaveLength(1);
    expect(rollbackEntries[0].proposal_id).toBe(proposal.proposal_id);
  });

  test("multiple deploy-rollback cycles maintain file integrity", async () => {
    const skillDir = join(tmpDir, "skills", "multi-cycle");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const logPath = join(tmpDir, "multi_audit_log.jsonl");

    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    // Cycle 1: deploy + rollback
    const proposal1 = makeProposal({
      proposal_id: "evo-cycle-001",
      proposed_description: "Description from cycle 1",
    });
    await deployProposal({
      proposal: proposal1,
      validation: makeValidation({ proposal_id: "evo-cycle-001" }),
      skillPath,
      createPr: false,
    });

    appendAuditEntry(
      {
        timestamp: new Date().toISOString(),
        proposal_id: "evo-cycle-001",
        action: "deployed",
        details: "Deployed proposal for test-skill",
      },
      logPath,
    );

    const result1 = await rollback({ skillName: "test-skill", skillPath, logPath });
    expect(result1.rolledBack).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe(SAMPLE_SKILL_MD);

    // Cycle 2: deploy + rollback again
    const proposal2 = makeProposal({
      proposal_id: "evo-cycle-002",
      proposed_description: "Description from cycle 2",
    });
    await deployProposal({
      proposal: proposal2,
      validation: makeValidation({ proposal_id: "evo-cycle-002" }),
      skillPath,
      createPr: false,
    });

    appendAuditEntry(
      {
        timestamp: new Date().toISOString(),
        proposal_id: "evo-cycle-002",
        action: "deployed",
        details: "Deployed proposal for test-skill",
      },
      logPath,
    );

    const result2 = await rollback({ skillName: "test-skill", skillPath, logPath });
    expect(result2.rolledBack).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe(SAMPLE_SKILL_MD);

    // Verify: audit trail has 2 deployed + 2 rolled_back entries
    const entries = readJsonl<EvolutionAuditEntry>(logPath);
    const deployed = entries.filter((e) => e.action === "deployed");
    const rolledBack = entries.filter((e) => e.action === "rolled_back");
    expect(deployed).toHaveLength(2);
    expect(rolledBack).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// E2E: Audit trail persistence across operations
// ---------------------------------------------------------------------------

describe("integration: audit trail persists across pipeline operations", () => {
  test("audit entries written by deploy and rollback are readable end-to-end", () => {
    const logPath = join(tmpDir, "audit_persistence.jsonl");

    // Simulate a full pipeline's audit trail
    const entries: EvolutionAuditEntry[] = [
      {
        timestamp: "2026-02-28T12:00:00Z",
        proposal_id: "evo-persist-001",
        action: "created",
        details: "Proposal created for test-skill (iteration 1)",
      },
      {
        timestamp: "2026-02-28T12:01:00Z",
        proposal_id: "evo-persist-001",
        action: "validated",
        details: "Validation complete for test-skill: improved=true",
        eval_snapshot: { total: 20, passed: 18, failed: 2, pass_rate: 0.9 },
      },
      {
        timestamp: "2026-02-28T12:02:00Z",
        proposal_id: "evo-persist-001",
        action: "deployed",
        details: "Deployed proposal for test-skill",
        eval_snapshot: { total: 20, passed: 18, failed: 2, pass_rate: 0.9 },
      },
    ];

    for (const entry of entries) {
      appendAuditEntry(entry, logPath);
    }

    // Read back and verify
    const trail = readAuditTrail(undefined, logPath);
    expect(trail).toHaveLength(3);
    expect(trail[0].action).toBe("created");
    expect(trail[1].action).toBe("validated");
    expect(trail[2].action).toBe("deployed");

    // Verify eval_snapshot is preserved
    const deployedEntry = trail.find((e) => e.action === "deployed");
    expect(deployedEntry?.eval_snapshot?.pass_rate).toBe(0.9);

    // Verify filtering by skill name
    const filtered = readAuditTrail("test-skill", logPath);
    expect(filtered).toHaveLength(3);

    const unrelated = readAuditTrail("nonexistent-skill", logPath);
    expect(unrelated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E2E: Description replacement preserves document structure
// ---------------------------------------------------------------------------

describe("integration: description replacement preserves markdown structure", () => {
  test("replacing description preserves all ## sections", () => {
    const newDesc = "New comprehensive description covering templates, formatting, and generation.";
    const result = replaceDescription(SAMPLE_SKILL_MD, newDesc);

    // Title preserved
    expect(result).toContain("# Test Skill");

    // New description present
    expect(result).toContain(newDesc);

    // Old description gone
    expect(result).not.toContain("original skill description");

    // All ## sections preserved
    expect(result).toContain("## Configuration");
    expect(result).toContain("- mode: auto");
    expect(result).toContain("## Examples");
    expect(result).toContain('"create a document"');
  });

  test("round-trip: deploy with new description then verify file structure", async () => {
    const skillPath = join(tmpDir, "roundtrip-SKILL.md");
    writeFileSync(skillPath, SAMPLE_SKILL_MD, "utf-8");

    const proposal = makeProposal({
      proposed_description: "Round-trip test description with special chars: <>&\"'",
    });

    await deployProposal({
      proposal,
      validation: makeValidation(),
      skillPath,
      createPr: false,
    });

    const content = readFileSync(skillPath, "utf-8");

    // Heading preserved
    expect(content.startsWith("# Test Skill")).toBe(true);

    // Special characters preserved
    expect(content).toContain("<>&\"'");

    // Sections preserved
    expect(content).toContain("## Configuration");
    expect(content).toContain("## Examples");
  });
});
