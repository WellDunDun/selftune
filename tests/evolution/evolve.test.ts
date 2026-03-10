import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvolveDeps,
  type EvolveOptions,
  evolve,
} from "../../cli/selftune/evolution/evolve.js";
import type { ValidationResult } from "../../cli/selftune/evolution/validate-proposal.js";
import type {
  EvalEntry,
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  EvolutionProposal,
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

function makeProposal(overrides: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    proposal_id: "evo-test-skill-123",
    skill_name: "test-skill",
    skill_path: "/tmp/test-skill/SKILL.md",
    original_description: "A skill for testing",
    proposed_description: "An improved skill for testing and validation",
    rationale: "Better coverage of test-related queries",
    failure_patterns: ["fp-test-0"],
    eval_results: {
      before: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
      after: { total: 0, passed: 0, failed: 0, pass_rate: 0 },
    },
    confidence: 0.8,
    created_at: new Date().toISOString(),
    status: "pending",
    ...overrides,
  };
}

function makeValidationResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    proposal_id: "evo-test-skill-123",
    before_pass_rate: 0.5,
    after_pass_rate: 0.9,
    improved: true,
    regressions: [],
    new_passes: [{ query: "how do I test things", should_trigger: true }],
    net_change: 0.4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock functions (no mock.module -- injected via _deps parameter)
// ---------------------------------------------------------------------------

const mockExtractFailurePatterns = mock(
  (_evalEntries: EvalEntry[], _skillUsage: SkillUsageRecord[], _skillName: string) => {
    return [makeFailurePattern()];
  },
);

const mockGenerateProposal = mock(
  async (
    _currentDesc: string,
    _patterns: FailurePattern[],
    _missed: string[],
    _skillName: string,
    _skillPath: string,
    _agent: string,
    _modelFlag?: string,
  ) => {
    return makeProposal();
  },
);

const mockValidateProposal = mock(
  async (
    _proposal: EvolutionProposal,
    _evalSet: EvalEntry[],
    _agent: string,
    _modelFlag?: string,
  ) => {
    return makeValidationResult();
  },
);

const mockGateValidateProposal = mock(
  async (
    _proposal: EvolutionProposal,
    _evalSet: EvalEntry[],
    _agent: string,
    _modelFlag?: string,
  ) => {
    return makeValidationResult();
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

// ---------------------------------------------------------------------------
// Default deps helper
// ---------------------------------------------------------------------------

function makeDeps(): EvolveDeps {
  return {
    extractFailurePatterns: mockExtractFailurePatterns,
    generateProposal: mockGenerateProposal,
    validateProposal: mockValidateProposal,
    gateValidateProposal: mockGateValidateProposal,
    appendAuditEntry: mockAppendAuditEntry,
    appendEvidenceEntry: mockAppendEvidenceEntry,
    buildEvalSet: mockBuildEvalSet,
    readSkillUsageLog: () => [],
  };
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function createTempSkill(skillContent = "# Test Skill\nA skill for testing"): {
  skillPath: string;
  skillDir: string;
} {
  const skillDir = join(
    tmpdir(),
    `selftune-test-evolve-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, skillContent, "utf-8");
  tmpDirs.push(skillDir);
  return { skillPath, skillDir };
}

function createTempEvalSet(entries: EvalEntry[]): string {
  const dir = join(
    tmpdir(),
    `selftune-test-evalset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const evalPath = join(dir, "eval_set.json");
  writeFileSync(evalPath, JSON.stringify(entries), "utf-8");
  tmpDirs.push(dir);
  return evalPath;
}

afterEach(() => {
  // Reset all mocks to default behavior
  mockExtractFailurePatterns.mockReset();
  mockExtractFailurePatterns.mockImplementation(
    (_evalEntries: unknown, _skillUsage: unknown, _skillName: unknown) => {
      return [makeFailurePattern()];
    },
  );

  mockGenerateProposal.mockReset();
  mockGenerateProposal.mockImplementation(async () => makeProposal());

  mockValidateProposal.mockReset();
  mockValidateProposal.mockImplementation(async () => makeValidationResult());

  mockGateValidateProposal.mockReset();
  mockGateValidateProposal.mockImplementation(async () => makeValidationResult());

  mockAppendAuditEntry.mockReset();
  mockAppendAuditEntry.mockImplementation(() => {});

  mockAppendEvidenceEntry.mockReset();
  mockAppendEvidenceEntry.mockImplementation(() => {});

  mockBuildEvalSet.mockReset();
  mockBuildEvalSet.mockImplementation(() => [
    { query: "test query", should_trigger: true },
    { query: "unrelated", should_trigger: false },
  ]);

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

function makeOptions(overrides: Partial<EvolveOptions> = {}): EvolveOptions {
  const { skillPath } = createTempSkill();
  return {
    skillName: "test-skill",
    skillPath,
    agent: "claude",
    dryRun: false,
    confidenceThreshold: 0.6,
    maxIterations: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("evolve orchestrator", () => {
  // 1. Dry run generates and validates but does not deploy
  test("dry run generates and validates but does not deploy", async () => {
    const opts = makeOptions({ dryRun: true });
    const result = await evolve(opts, makeDeps());

    expect(result.proposal).not.toBeNull();
    expect(result.validation).not.toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("dry");

    // Verify no "deployed" audit entry was written
    const deployedCalls = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "deployed",
    );
    expect(deployedCalls.length).toBe(0);
  });

  // 2. No failure patterns and no positive evals -> early exit with clear reason
  test("no failure patterns returns early with clear reason", async () => {
    mockExtractFailurePatterns.mockImplementation(() => []);
    // Use an eval set with only negatives so cold-start bootstrap doesn't apply
    mockBuildEvalSet.mockImplementation(() => [{ query: "unrelated", should_trigger: false }]);

    const opts = makeOptions();
    const result = await evolve(opts, makeDeps());

    expect(result.proposal).toBeNull();
    expect(result.validation).toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("no failure patterns");

    // generateProposal should NOT have been called
    expect(mockGenerateProposal.mock.calls.length).toBe(0);
  });

  // 2b. Cold-start bootstrap: no failure patterns + no usage history + positive evals -> proposal
  test("cold-start bootstrap uses positive evals as missed queries only for unused skills", async () => {
    mockExtractFailurePatterns.mockImplementation(() => []);

    const opts = makeOptions({ dryRun: true });
    const result = await evolve(opts, makeDeps());

    // Should proceed to proposal generation instead of early exit
    expect(result.proposal).not.toBeNull();
    expect(result.validation).not.toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("dry");
  });

  test("does not cold-start bootstrap when the skill already has usage history", async () => {
    mockExtractFailurePatterns.mockImplementation(() => []);

    const opts = makeOptions();
    const result = await evolve(opts, {
      ...makeDeps(),
      readSkillUsageLog: () => [
        {
          timestamp: new Date().toISOString(),
          session_id: "sess-existing",
          skill_name: "test-skill",
          skill_path: opts.skillPath,
          query: "test query",
          triggered: true,
          source: "test",
        },
      ],
    });

    expect(result.proposal).toBeNull();
    expect(result.validation).toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason).toBe("No failure patterns found");
    expect(mockGenerateProposal.mock.calls.length).toBe(0);
  });

  // 3. Low confidence -> rejected with reason
  test("low confidence proposal is rejected", async () => {
    mockGenerateProposal.mockImplementation(async () => makeProposal({ confidence: 0.3 }));

    const opts = makeOptions({ confidenceThreshold: 0.6 });
    const result = await evolve(opts, makeDeps());

    expect(result.proposal).not.toBeNull();
    expect(result.proposal?.confidence).toBe(0.3);
    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("confidence");

    // Should have a "rejected" audit entry
    const rejectedCalls = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "rejected",
    );
    expect(rejectedCalls.length).toBeGreaterThanOrEqual(1);

    // validateProposal should NOT have been called
    expect(mockValidateProposal.mock.calls.length).toBe(0);
  });

  // 4. Validation fails -> rejected with reason
  test("validation failure rejects the proposal", async () => {
    mockValidateProposal.mockImplementation(async () =>
      makeValidationResult({ improved: false, net_change: -0.1 }),
    );

    // Ensure all iterations fail validation
    mockGenerateProposal.mockImplementation(async () => makeProposal({ confidence: 0.9 }));

    const opts = makeOptions({ maxIterations: 1 });
    const result = await evolve(opts, makeDeps());

    expect(result.deployed).toBe(false);
    expect(result.reason.toLowerCase()).toContain("valid");

    // Should have a "rejected" audit entry for validation failure
    const rejectedCalls = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "rejected",
    );
    expect(rejectedCalls.length).toBeGreaterThanOrEqual(1);
  });

  // 5. Successful evolution -> proposal + validation + deployed=true
  test("successful evolution produces proposal, validation, and deployed=true", async () => {
    const opts = makeOptions();
    const result = await evolve(opts, makeDeps());

    expect(result.proposal).not.toBeNull();
    expect(result.validation).not.toBeNull();
    expect(result.validation?.improved).toBe(true);
    expect(result.deployed).toBe(true);
    expect(result.auditEntries.length).toBeGreaterThanOrEqual(3);

    // Verify "deployed" audit entry was written
    const deployedCalls = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "deployed",
    );
    expect(deployedCalls.length).toBe(1);

    const evidenceStages = mockAppendEvidenceEntry.mock.calls.map(
      (call: unknown[]) => (call[0] as EvolutionEvidenceEntry).stage,
    );
    expect(evidenceStages).toContain("created");
    expect(evidenceStages).toContain("validated");
    expect(evidenceStages).toContain("deployed");
  });

  // 6. Retry loop terminates at maxIterations
  test("retry loop terminates at maxIterations", async () => {
    // Every iteration: high confidence but validation always fails
    let generateCallCount = 0;
    mockGenerateProposal.mockImplementation(async () => {
      generateCallCount++;
      return makeProposal({ confidence: 0.9 });
    });
    mockValidateProposal.mockImplementation(async () =>
      makeValidationResult({ improved: false, net_change: -0.05 }),
    );

    const maxIterations = 3;
    const opts = makeOptions({ maxIterations });
    const result = await evolve(opts, makeDeps());

    expect(result.deployed).toBe(false);
    expect(generateCallCount).toBe(maxIterations);
  });

  // 7. Missing SKILL.md -> error reason
  test("missing SKILL.md returns error reason", async () => {
    const opts = makeOptions({
      skillPath: "/tmp/nonexistent-skill-path/SKILL.md",
    });

    const result = await evolve(opts, makeDeps());

    expect(result.proposal).toBeNull();
    expect(result.validation).toBeNull();
    expect(result.deployed).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  // 8. Audit entries collected throughout the flow
  test("audit entries are collected throughout the flow", async () => {
    const opts = makeOptions();
    const result = await evolve(opts, makeDeps());

    // Should have at least: "created", "validated", "deployed"
    expect(result.auditEntries.length).toBeGreaterThanOrEqual(3);

    const actions = result.auditEntries.map((e) => e.action);
    expect(actions).toContain("created");
    expect(actions).toContain("validated");
    expect(actions).toContain("deployed");

    // appendAuditEntry should have been called for each entry
    expect(mockAppendAuditEntry.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // 9. evalSetPath loads from file when provided
  test("uses evalSetPath when provided instead of building from logs", async () => {
    const evalEntries: EvalEntry[] = [
      { query: "custom eval query", should_trigger: true },
      { query: "custom negative", should_trigger: false },
    ];
    const evalSetPath = createTempEvalSet(evalEntries);

    const opts = makeOptions({ evalSetPath });
    const result = await evolve(opts, makeDeps());

    // buildEvalSet should NOT have been called since we provided evalSetPath
    expect(mockBuildEvalSet.mock.calls.length).toBe(0);
    expect(result.proposal).not.toBeNull();
  });

  // 10. validationModel flows through to validateProposal
  test("validationModel is passed to validateProposal", async () => {
    let capturedModelFlag: string | undefined;
    mockValidateProposal.mockImplementation(
      async (
        _proposal: EvolutionProposal,
        _evalSet: EvalEntry[],
        _agent: string,
        modelFlag?: string,
      ) => {
        capturedModelFlag = modelFlag;
        return makeValidationResult();
      },
    );

    const opts = makeOptions({ validationModel: "haiku" });
    await evolve(opts, makeDeps());

    expect(capturedModelFlag).toBe("haiku");
  });

  // 11. cheapLoop defaults proposalModel and validationModel to haiku, gateModel to sonnet
  test("cheapLoop sets default models", async () => {
    let capturedProposalModel: string | undefined;
    let capturedValidationModel: string | undefined;

    mockGenerateProposal.mockImplementation(
      async (
        _desc: string,
        _p: FailurePattern[],
        _m: string[],
        _sn: string,
        _sp: string,
        _a: string,
        modelFlag?: string,
      ) => {
        capturedProposalModel = modelFlag;
        return makeProposal();
      },
    );

    mockValidateProposal.mockImplementation(
      async (
        _proposal: EvolutionProposal,
        _evalSet: EvalEntry[],
        _agent: string,
        modelFlag?: string,
      ) => {
        capturedValidationModel = modelFlag;
        return makeValidationResult();
      },
    );

    const opts = makeOptions({ cheapLoop: true, dryRun: true });
    await evolve(opts, makeDeps());

    expect(capturedProposalModel).toBe("haiku");
    expect(capturedValidationModel).toBe("haiku");
  });

  // 12. Gate validation runs before deploy with gateModel
  test("gate validation runs before deploy when gateModel is set", async () => {
    let gateCalled = false;
    let gateModelUsed: string | undefined;

    mockGateValidateProposal.mockImplementation(
      async (
        _proposal: EvolutionProposal,
        _evalSet: EvalEntry[],
        _agent: string,
        modelFlag?: string,
      ) => {
        gateCalled = true;
        gateModelUsed = modelFlag;
        return makeValidationResult({ improved: true });
      },
    );

    const opts = makeOptions({ gateModel: "sonnet" });
    const result = await evolve(opts, makeDeps());

    expect(gateCalled).toBe(true);
    expect(gateModelUsed).toBe("sonnet");
    expect(result.deployed).toBe(true);
    expect(result.gateValidation).toBeDefined();
    expect(result.gateValidation?.improved).toBe(true);
  });

  // 13. Gate validation failure prevents deploy
  test("gate validation failure prevents deploy", async () => {
    mockGateValidateProposal.mockImplementation(async () =>
      makeValidationResult({ improved: false, net_change: -0.05 }),
    );

    const opts = makeOptions({ gateModel: "sonnet" });
    const result = await evolve(opts, makeDeps());

    expect(result.deployed).toBe(false);
    expect(result.reason).toContain("Gate validation failed");
    expect(result.reason).toContain("sonnet");
    expect(result.gateValidation).toBeDefined();
    expect(result.gateValidation?.improved).toBe(false);
  });

  // 14. No gate validation when gateModel is not set
  test("no gate validation when gateModel is not set", async () => {
    let gateCalled = false;
    mockGateValidateProposal.mockImplementation(async () => {
      gateCalled = true;
      return makeValidationResult();
    });

    const opts = makeOptions();
    const result = await evolve(opts, makeDeps());

    expect(gateCalled).toBe(false);
    expect(result.deployed).toBe(true);
    expect(result.gateValidation).toBeUndefined();
  });

  // 15. Retry feeds failure reason into subsequent proposal attempts
  test("retry loop feeds failure reason back to next iteration", async () => {
    const capturedArgs: unknown[][] = [];

    mockGenerateProposal.mockImplementation(async (...args: unknown[]) => {
      capturedArgs.push(args);
      return makeProposal({ confidence: 0.9 });
    });

    // First attempt fails validation, second succeeds
    let validateCallCount = 0;
    mockValidateProposal.mockImplementation(async () => {
      validateCallCount++;
      if (validateCallCount === 1) {
        return makeValidationResult({ improved: false, net_change: -0.1 });
      }
      return makeValidationResult({ improved: true });
    });

    const opts = makeOptions({ maxIterations: 3 });
    const result = await evolve(opts, makeDeps());

    // Should have been called twice (first fails, second succeeds)
    expect(capturedArgs.length).toBe(2);
    expect(result.deployed).toBe(true);
  });
});
