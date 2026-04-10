import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type EvolveDeps,
  type EvolveOptions,
  evolve,
  validateWithMode,
} from "../../cli/selftune/evolution/evolve.js";
import type { ReplayValidationOptions } from "../../cli/selftune/evolution/engines/replay-engine.js";
import type { ValidationResult } from "../../cli/selftune/evolution/validate-proposal.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
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
    _effort?: string,
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

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);

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
    paretoEnabled: false,
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

  test("sync-first refreshes source truth before building evals", async () => {
    const syncMock = mock(() => ({
      since: null,
      dry_run: false,
      sources: {
        claude: { available: true, scanned: 4, synced: 2, skipped: 0 },
        codex: { available: true, scanned: 1, synced: 1, skipped: 0 },
        opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
        openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
      },
      repair: {
        ran: true,
        repaired_sessions: 2,
        repaired_records: 7,
        codex_repaired_records: 1,
      },
    }));

    const opts = makeOptions({ dryRun: true, syncFirst: true, syncForce: true });
    const result = await evolve(opts, {
      ...makeDeps(),
      syncSources: syncMock,
    });

    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock.mock.calls[0]?.[0]).toMatchObject({
      force: true,
      dryRun: false,
      syncClaude: true,
      syncCodex: true,
      rebuildSkillUsage: true,
    });
    expect(result.sync_result?.repair.repaired_records).toBe(7);
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

    const createdAudit = mockAppendAuditEntry.mock.calls.find(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "created",
    );
    expect(
      (createdAudit?.[0] as EvolutionAuditEntry | undefined)?.details.startsWith(
        "original_description:",
      ),
    ).toBe(true);
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
    let gateEffortUsed: string | undefined;

    mockGateValidateProposal.mockImplementation(
      async (
        _proposal: EvolutionProposal,
        _evalSet: EvalEntry[],
        _agent: string,
        modelFlag?: string,
        effort?: string,
      ) => {
        gateCalled = true;
        gateModelUsed = modelFlag;
        gateEffortUsed = effort;
        return makeValidationResult({ improved: true });
      },
    );

    const opts = makeOptions({ gateModel: "sonnet" });
    const result = await evolve(opts, makeDeps());

    expect(gateCalled).toBe(true);
    expect(gateModelUsed).toBe("sonnet");
    expect(gateEffortUsed).toBeUndefined();
    expect(result.deployed).toBe(true);
    expect(result.gateValidation).toBeDefined();
    expect(result.gateValidation?.improved).toBe(true);
  });

  test("gate effort is passed to gate validation", async () => {
    let gateEffortUsed: string | undefined;

    mockGateValidateProposal.mockImplementation(
      async (
        _proposal: EvolutionProposal,
        _evalSet: EvalEntry[],
        _agent: string,
        _modelFlag?: string,
        effort?: string,
      ) => {
        gateEffortUsed = effort;
        return makeValidationResult({ improved: true });
      },
    );

    const opts = makeOptions({ gateModel: "opus", gateEffort: "high" });
    await evolve(opts, makeDeps());

    expect(gateEffortUsed).toBe("high");
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

    const rejectedCalls = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "rejected",
    );
    expect(rejectedCalls.length).toBeGreaterThanOrEqual(1);
    expect((rejectedCalls[rejectedCalls.length - 1][0] as EvolutionAuditEntry).details).toContain(
      "Gate validation failed",
    );

    const rejectedEvidence = mockAppendEvidenceEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionEvidenceEntry).stage === "rejected",
    );
    expect(rejectedEvidence.length).toBeGreaterThanOrEqual(1);
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

  test("adaptive gate escalates risky candidates to opus high effort", async () => {
    let gateModelUsed: string | undefined;
    let gateEffortUsed: string | undefined;

    mockGenerateProposal.mockImplementation(async () =>
      makeProposal({
        proposed_description: "An improved skill for testing and validation",
        confidence: 0.68,
      }),
    );
    mockValidateProposal.mockImplementation(async () =>
      makeValidationResult({
        improved: true,
        after_pass_rate: 0.82,
        net_change: 0.08,
        regressions: [],
      }),
    );
    mockGateValidateProposal.mockImplementation(
      async (
        _proposal: EvolutionProposal,
        _evalSet: EvalEntry[],
        _agent: string,
        modelFlag?: string,
        effort?: string,
      ) => {
        gateModelUsed = modelFlag;
        gateEffortUsed = effort;
        return makeValidationResult({ improved: true });
      },
    );

    const opts = makeOptions({ gateModel: "sonnet", adaptiveGate: true });
    await evolve(opts, makeDeps());

    expect(gateModelUsed).toBe("opus");
    expect(gateEffortUsed).toBe("high");
  });

  test("adaptive gate keeps base gate for low-risk candidates", async () => {
    let gateModelUsed: string | undefined;
    let gateEffortUsed: string | undefined;

    mockGenerateProposal.mockImplementation(async () =>
      makeProposal({
        proposed_description: "An improved skill for testing and validation",
        confidence: 0.91,
      }),
    );
    mockValidateProposal.mockImplementation(async () =>
      makeValidationResult({
        improved: true,
        after_pass_rate: 0.93,
        net_change: 0.2,
        regressions: [],
      }),
    );
    mockGateValidateProposal.mockImplementation(
      async (
        _proposal: EvolutionProposal,
        _evalSet: EvalEntry[],
        _agent: string,
        modelFlag?: string,
        effort?: string,
      ) => {
        gateModelUsed = modelFlag;
        gateEffortUsed = effort;
        return makeValidationResult({ improved: true });
      },
    );

    const opts = makeOptions({ gateModel: "sonnet", adaptiveGate: true });
    await evolve(opts, makeDeps());

    expect(gateModelUsed).toBe("sonnet");
    expect(gateEffortUsed).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Validation mode tests
  // ---------------------------------------------------------------------------

  test("--validation-mode judge uses judge engine (current behavior)", async () => {
    let validateCalled = false;
    mockValidateProposal.mockImplementation(async () => {
      validateCalled = true;
      return makeValidationResult({ validation_mode: "llm_judge" });
    });

    const opts = makeOptions({ validationMode: "judge" });
    const result = await evolve(opts, makeDeps());

    expect(validateCalled).toBe(true);
    expect(result.deployed).toBe(true);
    // Audit should record llm_judge
    const validatedAudits = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "validated",
    );
    expect(validatedAudits.length).toBeGreaterThanOrEqual(1);
    const lastValidated = validatedAudits[validatedAudits.length - 1][0] as EvolutionAuditEntry;
    expect(lastValidated.validation_mode).toBe("llm_judge");
  });

  test("--validation-mode auto falls back to judge when no replay fixture exists", async () => {
    let validateCalled = false;
    mockValidateProposal.mockImplementation(async () => {
      validateCalled = true;
      return makeValidationResult({ validation_mode: "llm_judge" });
    });

    // auto mode with no replayOptions provided -> should fall back to judge
    const opts = makeOptions({ validationMode: "auto" });
    const result = await evolve(opts, makeDeps());

    expect(validateCalled).toBe(true);
    expect(result.deployed).toBe(true);
    // Audit should record llm_judge since replay was not available
    const validatedAudits = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "validated",
    );
    expect(validatedAudits.length).toBeGreaterThanOrEqual(1);
    const lastValidated = validatedAudits[validatedAudits.length - 1][0] as EvolutionAuditEntry;
    expect(lastValidated.validation_mode).toBe("llm_judge");
  });

  test("--validation-mode auto uses replay when replay fixture is available", async () => {
    // Provide a replayOptions with a fixture and runner that succeeds
    // The runner is called twice: once with original desc, once with proposed desc.
    // Make the proposed run pass more entries so improved=true.
    let runnerCallCount = 0;
    const replayOptions: ReplayValidationOptions = {
      replayFixture: {
        fixture_id: "test-fixture",
        platform: "claude_code",
        target_skill_name: "test-skill",
        target_skill_path: "/tmp/test/SKILL.md",
        competing_skill_paths: [],
      },
      replayRunner: async (_input) => {
        runnerCallCount++;
        if (runnerCallCount === 1) {
          // "before" run: 1 of 2 pass
          return [
            { query: "test query", should_trigger: true, triggered: false, passed: false },
            { query: "unrelated", should_trigger: false, triggered: false, passed: true },
          ];
        }
        // "after" run: 2 of 2 pass
        return [
          { query: "test query", should_trigger: true, triggered: true, passed: true },
          { query: "unrelated", should_trigger: false, triggered: false, passed: true },
        ];
      },
    };

    // The judge validateProposal should NOT be called when replay succeeds
    let judgeCalled = false;
    mockValidateProposal.mockImplementation(async () => {
      judgeCalled = true;
      return makeValidationResult();
    });

    const opts = makeOptions({ validationMode: "auto", replayOptions });
    const result = await evolve(opts, makeDeps());

    expect(judgeCalled).toBe(false);
    expect(result.deployed).toBe(true);
    // Audit should record host_replay
    const validatedAudits = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "validated",
    );
    expect(validatedAudits.length).toBeGreaterThanOrEqual(1);
    const lastValidated = validatedAudits[validatedAudits.length - 1][0] as EvolutionAuditEntry;
    expect(lastValidated.validation_mode).toBe("host_replay");
  });

  test("--validation-mode replay fails gracefully when no fixture exists", async () => {
    const opts = makeOptions({ validationMode: "replay" });
    const result = await evolve(opts, makeDeps());

    // Should fail with a clear error about replay being unavailable
    expect(result.deployed).toBe(false);
    expect(result.reason).toContain("Replay validation requested");
  });

  test("audit entry records actual validation_mode used", async () => {
    // Use judge mode explicitly and verify audit records it
    mockValidateProposal.mockImplementation(async () =>
      makeValidationResult({ validation_mode: "llm_judge" }),
    );

    const opts = makeOptions({ validationMode: "judge" });
    await evolve(opts, makeDeps());

    // Check the deployed audit entry
    const deployedAudits = mockAppendAuditEntry.mock.calls.filter(
      (call: unknown[]) => (call[0] as EvolutionAuditEntry).action === "deployed",
    );
    expect(deployedAudits.length).toBe(1);
    const deployedAudit = deployedAudits[0][0] as EvolutionAuditEntry;
    expect(deployedAudit.validation_mode).toBe("llm_judge");
  });

  // ---------------------------------------------------------------------------
  // validateWithMode unit tests
  // ---------------------------------------------------------------------------

  test("validateWithMode routes judge mode to validateFn", async () => {
    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [{ query: "test", should_trigger: true }];
    const mockFn = mock(async () => makeValidationResult());

    const { result, modeUsed } = await validateWithMode(
      "judge",
      proposal,
      evalSet,
      "claude",
      undefined,
      mockFn,
    );

    expect(modeUsed).toBe("llm_judge");
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(result.proposal_id).toBe(proposal.proposal_id);
  });

  test("validateWithMode auto mode falls back to judge with no replay options", async () => {
    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [{ query: "test", should_trigger: true }];
    const mockFn = mock(async () => makeValidationResult());

    const { modeUsed } = await validateWithMode(
      "auto",
      proposal,
      evalSet,
      "claude",
      undefined,
      mockFn,
    );

    expect(modeUsed).toBe("llm_judge");
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  test("validateWithMode auto mode uses replay when fixture available", async () => {
    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [
      {
        query: "test",
        should_trigger: true,
        invocation_type: "contextual",
        source: "log",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const mockFn = mock(async () => makeValidationResult());

    let callCount = 0;
    const replayOpts: ReplayValidationOptions = {
      replayFixture: {
        fixture_id: "f1",
        platform: "claude_code",
        target_skill_name: "test-skill",
        target_skill_path: "/tmp/test/SKILL.md",
        competing_skill_paths: [],
      },
      replayRunner: async () => {
        callCount++;
        return [
          { query: "test", should_trigger: true, triggered: callCount > 1, passed: callCount > 1 },
        ];
      },
    };

    const { result, modeUsed } = await validateWithMode(
      "auto",
      proposal,
      evalSet,
      "claude",
      replayOpts,
      mockFn,
    );

    expect(modeUsed).toBe("host_replay");
    // Judge should NOT have been called
    expect(mockFn).toHaveBeenCalledTimes(0);
    expect(result.validation_fixture_id).toBe("f1");
    expect(result.per_entry_results?.[0]?.entry).toMatchObject({
      query: "test",
      should_trigger: true,
      invocation_type: "contextual",
      source: "log",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(result.before_entry_results?.[0]?.entry).toMatchObject({
      query: "test",
      should_trigger: true,
      invocation_type: "contextual",
      source: "log",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("validateWithMode replay mode throws when no fixture", async () => {
    const proposal = makeProposal();
    const evalSet: EvalEntry[] = [{ query: "test", should_trigger: true }];
    const mockFn = mock(async () => makeValidationResult());

    expect(
      validateWithMode("replay", proposal, evalSet, "claude", undefined, mockFn),
    ).rejects.toThrow("Replay validation requested");
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
