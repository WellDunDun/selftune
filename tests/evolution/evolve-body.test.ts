import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvolveBodyDeps,
  type EvolveBodyOptions,
  evolveBody,
} from "../../cli/selftune/evolution/evolve-body.js";
import type {
  BodyEvolutionProposal,
  BodyValidationResult,
  EvalEntry,
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  FailurePattern,
  QueryLogRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Deterministic mock factories
// ---------------------------------------------------------------------------

function makeFailurePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    pattern_id: "fp-test-0",
    skill_name: "test-skill",
    invocation_type: "implicit",
    missed_queries: ["how do I test things", "run my tests"],
    frequency: 2,
    sample_sessions: [],
    extracted_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeBodyProposal(overrides: Partial<BodyEvolutionProposal> = {}): BodyEvolutionProposal {
  return {
    proposal_id: "evo-body-test-skill-123",
    skill_name: "test-skill",
    skill_path: "/tmp/test-skill/SKILL.md",
    original_body: "Original body content",
    proposed_body:
      "Improved body.\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |",
    rationale: "Better coverage",
    target: "body",
    failure_patterns: ["fp-test-0"],
    confidence: 0.8,
    created_at: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

function makeValidationResult(overrides: Partial<BodyValidationResult> = {}): BodyValidationResult {
  return {
    proposal_id: "evo-body-test-skill-123",
    gates_passed: 3,
    gates_total: 3,
    gate_results: [
      { gate: "structural", passed: true, reason: "Valid" },
      { gate: "trigger_accuracy", passed: true, reason: "Improved" },
      { gate: "quality", passed: true, reason: "Score: 0.85" },
    ],
    improved: true,
    regressions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock functions (injected via _deps parameter)
// ---------------------------------------------------------------------------

const mockExtractFailurePatterns = mock(
  (_evalEntries: EvalEntry[], _skillUsage: SkillUsageRecord[], _skillName: string) => {
    return [makeFailurePattern()];
  },
);

const mockGenerateBodyProposal = mock(
  async (
    _currentContent: string,
    _patterns: FailurePattern[],
    _missed: string[],
    _skillName: string,
    _skillPath: string,
    _agent: string,
    _modelFlag?: string,
    _fewShot?: string[],
  ) => {
    return makeBodyProposal();
  },
);

const mockGenerateRoutingProposal = mock(
  async (
    _currentRouting: string,
    _fullContent: string,
    _patterns: FailurePattern[],
    _missed: string[],
    _skillName: string,
    _skillPath: string,
    _agent: string,
    _modelFlag?: string,
  ) => {
    return makeBodyProposal({ target: "routing" });
  },
);

const mockValidateBodyProposal = mock(
  async (_proposal: BodyEvolutionProposal, _evalSet: EvalEntry[], _agent: string) => {
    return makeValidationResult();
  },
);

const mockValidateRoutingProposal = mock(
  async (_proposal: BodyEvolutionProposal, _evalSet: EvalEntry[], _agent: string) => {
    return makeValidationResult({ gates_total: 2, gates_passed: 2 });
  },
);

const mockRefineBodyProposal = mock(
  async (_proposal: BodyEvolutionProposal, _validation: BodyValidationResult, _agent: string) => {
    return makeBodyProposal({ proposal_id: "evo-body-refined" });
  },
);

const mockAppendAuditEntry = mock((_entry: EvolutionAuditEntry, _logPath?: string) => {});
const mockAppendEvidenceEntry = mock((_entry: EvolutionEvidenceEntry, _logPath?: string) => {});

const mockBuildEvalSet = mock(
  (_skillRecords: SkillUsageRecord[], _queryRecords: QueryLogRecord[], _skillName: string) => {
    return [
      { query: "test query", should_trigger: true },
      { query: "unrelated", should_trigger: false },
    ] as EvalEntry[];
  },
);

const mockWriteFileSync = mock((_path: string, _data: string, _encoding: string) => {});

// ---------------------------------------------------------------------------
// Default deps helper
// ---------------------------------------------------------------------------

function makeDeps(): EvolveBodyDeps {
  return {
    extractFailurePatterns: mockExtractFailurePatterns,
    generateBodyProposal: mockGenerateBodyProposal,
    generateRoutingProposal: mockGenerateRoutingProposal,
    validateBodyProposal: mockValidateBodyProposal,
    validateRoutingProposal: mockValidateRoutingProposal,
    refineBodyProposal: mockRefineBodyProposal,
    appendAuditEntry: mockAppendAuditEntry,
    appendEvidenceEntry: mockAppendEvidenceEntry,
    buildEvalSet: mockBuildEvalSet,
    writeFileSync: mockWriteFileSync,
  };
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function createTempSkill(
  skillContent = "---\nname: test\n---\n\n# Test Skill\nA skill for testing\n\n## Workflow Routing\n\n| Trigger | Workflow |\n| --- | --- |\n| test | run |",
): {
  skillPath: string;
  skillDir: string;
} {
  const skillDir = join(
    tmpdir(),
    `selftune-test-evolve-body-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, skillContent, "utf-8");
  tmpDirs.push(skillDir);
  return { skillPath, skillDir };
}

afterEach(() => {
  // Reset all mocks
  mockExtractFailurePatterns.mockReset();
  mockExtractFailurePatterns.mockImplementation(() => [makeFailurePattern()]);

  mockGenerateBodyProposal.mockReset();
  mockGenerateBodyProposal.mockImplementation(async () => makeBodyProposal());

  mockGenerateRoutingProposal.mockReset();
  mockGenerateRoutingProposal.mockImplementation(async () =>
    makeBodyProposal({ target: "routing" }),
  );

  mockValidateBodyProposal.mockReset();
  mockValidateBodyProposal.mockImplementation(async () => makeValidationResult());

  mockValidateRoutingProposal.mockReset();
  mockValidateRoutingProposal.mockImplementation(async () =>
    makeValidationResult({ gates_total: 2, gates_passed: 2 }),
  );

  mockRefineBodyProposal.mockReset();
  mockRefineBodyProposal.mockImplementation(async () =>
    makeBodyProposal({ proposal_id: "evo-body-refined" }),
  );

  mockAppendAuditEntry.mockReset();
  mockAppendAuditEntry.mockImplementation(() => {});

  mockAppendEvidenceEntry.mockReset();
  mockAppendEvidenceEntry.mockImplementation(() => {});

  mockBuildEvalSet.mockReset();
  mockBuildEvalSet.mockImplementation(() => [
    { query: "test query", should_trigger: true },
    { query: "unrelated", should_trigger: false },
  ]);

  mockWriteFileSync.mockReset();
  mockWriteFileSync.mockImplementation(() => {});

  // Clean up temp dirs
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Default options helper
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<EvolveBodyOptions> = {}): EvolveBodyOptions {
  const { skillPath } = createTempSkill();
  return {
    skillName: "test-skill",
    skillPath,
    target: "body",
    teacherAgent: "claude",
    studentAgent: "claude",
    dryRun: false,
    maxIterations: 3,
    confidenceThreshold: 0.6,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("evolveBody orchestrator", () => {
  test("dry run generates and validates but does not deploy", async () => {
    const opts = makeOptions({ dryRun: true });
    const result = await evolveBody(opts, makeDeps());

    expect(result.proposal).not.toBeNull();
    expect(result.validation).not.toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("dry");

    // Verify writeFileSync was NOT called (no deploy)
    expect(mockWriteFileSync.mock.calls.length).toBe(0);
  });

  test("no failure patterns returns early", async () => {
    mockExtractFailurePatterns.mockImplementation(() => []);

    const opts = makeOptions();
    const result = await evolveBody(opts, makeDeps());

    expect(result.proposal).toBeNull();
    expect(result.validation).toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("no failure patterns");

    expect(mockGenerateBodyProposal.mock.calls.length).toBe(0);
  });

  test("low confidence proposal is rejected", async () => {
    mockGenerateBodyProposal.mockImplementation(async () => makeBodyProposal({ confidence: 0.3 }));

    const opts = makeOptions({ confidenceThreshold: 0.6, maxIterations: 1 });
    const result = await evolveBody(opts, makeDeps());

    expect(result.proposal).not.toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("confidence");
  });

  test("validation failure leads to refinement on next iteration", async () => {
    // First validation fails, second succeeds
    let validateCallCount = 0;
    mockValidateBodyProposal.mockImplementation(async () => {
      validateCallCount++;
      if (validateCallCount === 1) {
        return makeValidationResult({
          improved: false,
          gates_passed: 1,
          gate_results: [
            { gate: "structural", passed: true, reason: "Valid" },
            { gate: "trigger_accuracy", passed: false, reason: "Not improved" },
            { gate: "quality", passed: false, reason: "Low quality" },
          ],
        });
      }
      return makeValidationResult();
    });

    const opts = makeOptions({ maxIterations: 3 });
    const result = await evolveBody(opts, makeDeps());

    expect(result.deployed).toBe(true);
    // Refine should have been called once
    expect(mockRefineBodyProposal.mock.calls.length).toBe(1);
  });

  test("successful evolution deploys and writes file", async () => {
    const opts = makeOptions();
    const result = await evolveBody(opts, makeDeps());

    expect(result.proposal).not.toBeNull();
    expect(result.validation).not.toBeNull();
    expect(result.deployed).toBe(true);
    expect(result.reason).toContain("deployed successfully");

    // writeFileSync should have been called
    expect(mockWriteFileSync.mock.calls.length).toBe(1);

    const evidenceStages = mockAppendEvidenceEntry.mock.calls.map(
      (call: unknown[]) => (call[0] as EvolutionEvidenceEntry).stage,
    );
    expect(evidenceStages).toContain("created");
    expect(evidenceStages).toContain("validated");
    expect(evidenceStages).toContain("deployed");
  });

  test("missing SKILL.md returns error", async () => {
    const opts = makeOptions({
      skillPath: "/tmp/nonexistent-skill-path/SKILL.md",
    });

    const result = await evolveBody(opts, makeDeps());

    expect(result.proposal).toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason).toContain("not found");
  });

  test("audit entries collected throughout flow", async () => {
    const opts = makeOptions();
    const result = await evolveBody(opts, makeDeps());

    expect(result.auditEntries.length).toBeGreaterThanOrEqual(3);
    const actions = result.auditEntries.map((e) => e.action);
    expect(actions).toContain("created");
    expect(actions).toContain("validated");
    expect(actions).toContain("deployed");
  });

  test("routing target uses routing proposal and validation", async () => {
    const opts = makeOptions({ target: "routing" });
    const result = await evolveBody(opts, makeDeps());

    expect(result.deployed).toBe(true);
    expect(mockGenerateRoutingProposal.mock.calls.length).toBe(1);
    expect(mockValidateRoutingProposal.mock.calls.length).toBe(1);
    // Body-specific functions should NOT have been called
    expect(mockGenerateBodyProposal.mock.calls.length).toBe(0);
    expect(mockValidateBodyProposal.mock.calls.length).toBe(0);
  });

  test("retry loop terminates at maxIterations", async () => {
    let generateCallCount = 0;
    mockGenerateBodyProposal.mockImplementation(async () => {
      generateCallCount++;
      return makeBodyProposal({ confidence: 0.9 });
    });
    mockValidateBodyProposal.mockImplementation(async () =>
      makeValidationResult({ improved: false, gates_passed: 1 }),
    );

    const maxIterations = 2;
    const opts = makeOptions({ maxIterations });
    const result = await evolveBody(opts, makeDeps());

    expect(result.deployed).toBe(false);
    // First iteration generates, second iteration refines
    expect(generateCallCount).toBe(1);
    expect(mockRefineBodyProposal.mock.calls.length).toBe(1);
  });

  test("error during evolution returns gracefully", async () => {
    mockGenerateBodyProposal.mockImplementation(async () => {
      throw new Error("LLM call failed");
    });

    const opts = makeOptions();
    const result = await evolveBody(opts, makeDeps());

    expect(result.proposal).toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason).toContain("Error");
    expect(result.reason).toContain("LLM call failed");
  });
});
