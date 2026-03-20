/**
 * End-to-end autonomy proof harness.
 *
 * Proves the three claims that underpin selftune's autonomous evolution thesis:
 *
 *   1. A low-risk description evolution can deploy autonomously
 *      (sync → status → candidate selection → evolve → deploy)
 *
 *   2. Post-deploy regressions are detected by the watch step
 *      (watch reads post-deploy telemetry and fires an alert)
 *
 *   3. Rollback happens automatically when autoRollback is enabled
 *      (watch detects regression → invokes rollback → SKILL.md restored)
 *
 * Design:
 *  - Uses dependency injection (OrchestrateDeps / EvolveDeps / WatchOptions)
 *    to avoid real LLM calls while exercising real file I/O.
 *  - Realistic fixtures: actual SKILL.md files on disk, JSONL audit logs,
 *    real deployProposal() writes, real rollback() restores.
 *  - Every assertion checks observable state (file contents, audit entries,
 *    function call args) — no hand-wavy "it probably worked" checks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry, readAuditTrail } from "../cli/selftune/evolution/audit.js";
import { type EvolveOptions, evolve } from "../cli/selftune/evolution/evolve.js";
import { rollback } from "../cli/selftune/evolution/rollback.js";
import type { ValidationResult } from "../cli/selftune/evolution/validate-proposal.js";
import { _setTestDb, openDb } from "../cli/selftune/localdb/db.js";
import type { WatchOptions, WatchResult } from "../cli/selftune/monitoring/watch.js";
import { watch } from "../cli/selftune/monitoring/watch.js";
import {
  type OrchestrateDeps,
  orchestrate,
  selectCandidates,
} from "../cli/selftune/orchestrate.js";
import type { SkillStatus, StatusResult } from "../cli/selftune/status.js";
import type { SyncResult, SyncStepResult } from "../cli/selftune/sync.js";
import type {
  DoctorResult,
  EvalEntry,
  EvolutionProposal,
  FailurePattern,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SKILL_MD_ORIGINAL = `---
name: test-autonomy
description: Helps users with autonomy testing tasks like running test suites and checking test coverage.
---

# test-autonomy

Helps users with autonomy testing tasks.

## When to Use

- User asks to run tests
- User asks about test coverage

## Examples

- "run my tests"
- "check test coverage"
`;

const PROPOSED_DESCRIPTION =
  "Helps users with autonomy testing, test suite execution, coverage analysis, CI pipeline debugging, and flaky test diagnosis. Triggers on test-related queries including running, debugging, and analyzing test results.";

function makeProposal(skillPath: string): EvolutionProposal {
  return {
    proposal_id: "evo-autonomy-proof-001",
    skill_name: "test-autonomy",
    skill_path: skillPath,
    original_description:
      "Helps users with autonomy testing tasks like running test suites and checking test coverage.",
    proposed_description: PROPOSED_DESCRIPTION,
    rationale: "Expanded coverage for CI/flaky test queries that were being missed",
    failure_patterns: ["fp-test-autonomy-0"],
    eval_results: {
      before: { total: 10, passed: 6, failed: 4, pass_rate: 0.6 },
      after: { total: 10, passed: 9, failed: 1, pass_rate: 0.9 },
    },
    confidence: 0.82,
    created_at: "2026-03-14T12:00:00Z",
    status: "validated",
  };
}

function makeValidation(): ValidationResult {
  return {
    proposal_id: "evo-autonomy-proof-001",
    before_pass_rate: 0.6,
    after_pass_rate: 0.9,
    improved: true,
    regressions: [],
    new_passes: [
      { query: "debug flaky test", should_trigger: true },
      { query: "why is CI failing", should_trigger: true },
      { query: "analyze test coverage report", should_trigger: true },
    ],
    net_change: 0.3,
  };
}

function makeFailurePattern(): FailurePattern {
  return {
    pattern_id: "fp-test-autonomy-0",
    skill_name: "test-autonomy",
    invocation_type: "implicit",
    missed_queries: ["debug flaky test", "why is CI failing", "analyze test coverage report"],
    frequency: 3,
    sample_sessions: [],
    extracted_at: "2026-03-14T12:00:00Z",
  };
}

function makeEvalSet(): EvalEntry[] {
  return [
    { query: "run my tests", should_trigger: true, invocation_type: "explicit" },
    { query: "check test coverage", should_trigger: true, invocation_type: "explicit" },
    { query: "debug flaky test", should_trigger: true, invocation_type: "implicit" },
    { query: "why is CI failing", should_trigger: true, invocation_type: "implicit" },
    { query: "analyze test coverage report", should_trigger: true, invocation_type: "implicit" },
    { query: "what is the weather", should_trigger: false, invocation_type: "negative" },
    { query: "write a blog post", should_trigger: false, invocation_type: "negative" },
    { query: "deploy to production", should_trigger: false, invocation_type: "negative" },
    { query: "fix the login page", should_trigger: false, invocation_type: "negative" },
    { query: "how do I use git rebase", should_trigger: false, invocation_type: "negative" },
  ];
}

function makeSyncResult(): SyncResult {
  const step: SyncStepResult = { available: true, scanned: 5, synced: 3, skipped: 2 };
  return {
    since: null,
    dry_run: false,
    sources: { claude: step, codex: step, opencode: step, openclaw: step },
    repair: { ran: true, repaired_sessions: 0, repaired_records: 0, codex_repaired_records: 0 },
  };
}

function makeDoctorResult(): DoctorResult {
  return {
    command: "doctor",
    timestamp: new Date().toISOString(),
    checks: [],
    summary: { pass: 5, fail: 0, warn: 0, total: 5 },
    healthy: true,
  };
}

function makeStatusResult(skills: SkillStatus[]): StatusResult {
  return {
    skills,
    unmatchedQueries: 3,
    pendingProposals: 0,
    lastSession: null,
    system: { healthy: true, pass: 5, fail: 0, warn: 0 },
  };
}

function makeSkill(overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    name: "test-autonomy",
    passRate: 0.6,
    trend: "down",
    missedQueries: 3,
    status: "WARNING",
    snapshot: {
      timestamp: "2026-03-14T12:00:00Z",
      skill_name: "test-autonomy",
      window_sessions: 20,
      skill_checks: 10,
      pass_rate: 0.6,
      false_negative_rate: 0.1,
      by_invocation_type: {
        explicit: { passed: 3, total: 5 },
        implicit: { passed: 3, total: 5 },
        contextual: { passed: 0, total: 0 },
        negative: { passed: 0, total: 0 },
      },
      regression_detected: false,
      baseline_pass_rate: 0.8,
    },
    ...overrides,
  };
}

function makeTelemetryRecord(
  overrides: Partial<SessionTelemetryRecord> = {},
): SessionTelemetryRecord {
  return {
    timestamp: "2026-03-14T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    cwd: "/tmp/project",
    transcript_path: "/tmp/transcript.jsonl",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: [],
    assistant_turns: 1,
    errors_encountered: 0,
    transcript_chars: 100,
    last_user_query: "test query",
    ...overrides,
  };
}

function makeSkillUsageRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    timestamp: "2026-03-14T12:00:00Z",
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    skill_name: "test-autonomy",
    skill_path: "/tmp/skills/test-autonomy/SKILL.md",
    query: "run my tests",
    triggered: true,
    ...overrides,
  };
}

function writeJsonl<T>(records: T[], filePath: string): void {
  const content = records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
  writeFileSync(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-autonomy-proof-"));
  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// SCENARIO 1: Autonomous deploy — full pipeline, no human in the loop
// ===========================================================================

describe("autonomy proof: autonomous deploy end-to-end", () => {
  test("orchestrate selects a WARNING skill, evolve deploys it, file is updated", async () => {
    // --- Arrange: set up a real SKILL.md on disk ---
    const skillDir = join(tmpDir, "skills", "test-autonomy");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, SKILL_MD_ORIGINAL, "utf-8");

    const proposal = makeProposal(skillPath);
    const validation = makeValidation();

    // Track what orchestrate passes to evolve
    let evolveCalled = false;
    let evolveOpts: EvolveOptions | null = null;

    const deps: OrchestrateDeps = {
      syncSources: () => makeSyncResult(),
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "test-autonomy", status: "WARNING", passRate: 0.6, missedQueries: 3 }),
        ]),
      detectAgent: () => "claude",
      doctor: () => makeDoctorResult(),
      readTelemetry: () => [],
      readSkillRecords: () => [],
      readQueryRecords: () => [],
      readAuditEntries: () => [],
      resolveSkillPath: (name) => (name === "test-autonomy" ? skillPath : undefined),
      readGradingResults: () => [],
      readAlphaIdentity: () => null,
      // This is the key: evolve() does real file I/O via deployProposal, but we
      // control the LLM-dependent steps (pattern extraction, proposal, validation)
      // by returning deterministic results.
      evolve: async (opts) => {
        evolveCalled = true;
        evolveOpts = opts;

        // Run the real evolve with injected deps that skip LLM calls
        const result = await evolve(opts, {
          extractFailurePatterns: () => [makeFailurePattern()],
          generateProposal: async () => proposal,
          validateProposal: async () => validation,
          appendAuditEntry: (entry) => appendAuditEntry(entry),
          appendEvidenceEntry: () => {},
          buildEvalSet: () => makeEvalSet(),
          updateContextAfterEvolve: () => {},
          measureBaseline: async () => ({
            baseline_pass_rate: 0.5,
            proposed_pass_rate: 0.9,
            lift: 0.4,
            adds_value: true,
          }),
          readSkillUsageLog: () => [],
        });

        return result;
      },
      watch: async () => ({
        snapshot: {
          timestamp: new Date().toISOString(),
          skill_name: "test-autonomy",
          window_sessions: 20,
          skill_checks: 10,
          pass_rate: 0.9,
          false_negative_rate: 0.1,
          by_invocation_type: {
            explicit: { passed: 5, total: 5 },
            implicit: { passed: 4, total: 5 },
            contextual: { passed: 0, total: 0 },
            negative: { passed: 0, total: 0 },
          },
          regression_detected: false,
          baseline_pass_rate: 0.8,
        },
        alert: null,
        rolledBack: false,
        recommendation: "stable",
      }),
    };

    // --- Act ---
    const result = await orchestrate(
      {
        dryRun: false,
        approvalMode: "auto",
        maxSkills: 5,
        recentWindowHours: 48,
        syncForce: false,
      },
      deps,
    );

    // --- Assert: orchestrate picked the right candidate ---
    expect(result.summary.evaluated).toBe(1);
    expect(evolveCalled).toBe(true);
    expect(evolveOpts?.dryRun).toBe(false); // autonomous mode = dryRun false
    expect(evolveOpts?.skillName).toBe("test-autonomy");

    // --- Assert: evolve actually deployed (real file I/O) ---
    const candidate = result.candidates.find((c) => c.skill === "test-autonomy");
    expect(candidate).toBeDefined();
    expect(candidate?.evolveResult).toBeDefined();
    expect(candidate?.evolveResult?.deployed).toBe(true);

    // --- Assert: SKILL.md on disk was updated ---
    // Note: replaceFrontmatterDescription may YAML-fold the description, so we
    // check for a distinctive substring rather than the full string verbatim.
    const updatedContent = readFileSync(skillPath, "utf-8");
    expect(updatedContent).toContain("flaky test diagnosis");
    expect(updatedContent).toContain("coverage analysis");
    expect(updatedContent).not.toContain(
      "Helps users with autonomy testing tasks like running test suites and checking test coverage.",
    );

    // --- Assert: backup file exists ---
    const backupPath = `${skillPath}.bak`;
    expect(existsSync(backupPath)).toBe(true);
    const backupContent = readFileSync(backupPath, "utf-8");
    expect(backupContent).toBe(SKILL_MD_ORIGINAL);

    // --- Assert: audit trail has created + validated + deployed entries ---
    const auditEntries = readAuditTrail();
    const actions = auditEntries.map((e) => e.action);
    expect(actions).toContain("created");
    expect(actions).toContain("validated");
    expect(actions).toContain("deployed");

    const deployedEntry = auditEntries.find((e) => e.action === "deployed");
    expect(deployedEntry?.proposal_id).toBe("evo-autonomy-proof-001");
    expect(deployedEntry?.eval_snapshot?.pass_rate).toBe(0.9);
  });

  test("review-required mode prevents autonomous deploy", async () => {
    const skillDir = join(tmpDir, "skills", "review-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, SKILL_MD_ORIGINAL, "utf-8");

    let evolveDryRunArg: boolean | undefined;

    const deps: OrchestrateDeps = {
      syncSources: () => makeSyncResult(),
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "review-skill", status: "WARNING", passRate: 0.5, missedQueries: 5 }),
        ]),
      detectAgent: () => "claude",
      doctor: () => makeDoctorResult(),
      readTelemetry: () => [],
      readSkillRecords: () => [],
      readQueryRecords: () => [],
      readAuditEntries: () => [],
      resolveSkillPath: () => skillPath,
      readGradingResults: () => [],
      readAlphaIdentity: () => null,
      evolve: async (opts) => {
        evolveDryRunArg = opts.dryRun;
        return {
          proposal: makeProposal(skillPath),
          validation: makeValidation(),
          deployed: false,
          auditEntries: [],
          reason: "Dry run - proposal validated but not deployed",
          llmCallCount: 2,
          elapsedMs: 100,
        };
      },
      watch: async () => ({
        snapshot: {
          timestamp: new Date().toISOString(),
          skill_name: "review-skill",
          window_sessions: 20,
          skill_checks: 0,
          pass_rate: 0,
          false_negative_rate: 0,
          by_invocation_type: {
            explicit: { passed: 0, total: 0 },
            implicit: { passed: 0, total: 0 },
            contextual: { passed: 0, total: 0 },
            negative: { passed: 0, total: 0 },
          },
          regression_detected: false,
          baseline_pass_rate: 0.5,
        },
        alert: null,
        rolledBack: false,
        recommendation: "stable",
      }),
    };

    await orchestrate(
      {
        dryRun: false,
        approvalMode: "review",
        maxSkills: 5,
        recentWindowHours: 48,
        syncForce: false,
      },
      deps,
    );

    // review-required forces dryRun=true on evolve
    expect(evolveDryRunArg).toBe(true);

    // SKILL.md unchanged
    expect(readFileSync(skillPath, "utf-8")).toBe(SKILL_MD_ORIGINAL);
  });
});

// ===========================================================================
// SCENARIO 2: Watch detects regression
// ===========================================================================

describe("autonomy proof: watch detects regression", () => {
  test("regression detected from real JSONL logs triggers alert", async () => {
    // Simulate post-deploy telemetry where the skill regresses badly
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-regress-${i}`);

    const telemetry = sessionIds.map((sid) => makeTelemetryRecord({ session_id: sid }));

    // Only 1 of 10 triggered = 0.1 pass rate, well below 0.8 baseline
    const skillRecords = [
      makeSkillUsageRecord({ session_id: sessionIds[0], triggered: true }),
      ...sessionIds
        .slice(1)
        .map((sid) => makeSkillUsageRecord({ session_id: sid, triggered: false })),
    ];

    const queryRecords = sessionIds.map(
      (sid) =>
        ({
          timestamp: "2026-03-14T12:00:00Z",
          session_id: sid,
          query: "run tests",
        }) as QueryLogRecord,
    );

    // Write deployed audit entry to SQLite establishing 0.8 baseline
    appendAuditEntry({
      timestamp: "2026-03-14T10:00:00Z",
      proposal_id: "evo-autonomy-proof-001",
      action: "deployed",
      details: "Deployed test-autonomy proposal",
      skill_name: "test-autonomy",
      eval_snapshot: { total: 10, passed: 8, failed: 2, pass_rate: 0.8 },
    });

    const telemetryPath = join(tmpDir, "telemetry.jsonl");
    const skillLogPath = join(tmpDir, "skill_usage.jsonl");
    const queryLogPath = join(tmpDir, "queries.jsonl");

    writeJsonl(telemetry, telemetryPath);
    writeJsonl(skillRecords, skillLogPath);
    writeJsonl(queryRecords, queryLogPath);

    const result: WatchResult = await watch({
      skillName: "test-autonomy",
      skillPath: "/tmp/skills/test-autonomy/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
    } as unknown as WatchOptions);

    // Regression: 0.1 pass rate < 0.8 - 0.1 = 0.7 threshold
    expect(result.snapshot.regression_detected).toBe(true);
    expect(result.snapshot.pass_rate).toBeCloseTo(0.1, 2);
    expect(result.snapshot.baseline_pass_rate).toBe(0.8);
    expect(result.alert).not.toBeNull();
    expect(result.alert ?? "").toContain("regression");
    expect(result.rolledBack).toBe(false); // autoRollback was off
  });

  test("no regression when performance stays above threshold", async () => {
    const sessionIds = Array.from({ length: 5 }, (_, i) => `sess-stable-${i}`);

    const telemetry = sessionIds.map((sid) =>
      makeTelemetryRecord({ session_id: sid, skills_triggered: ["test-autonomy"] }),
    );

    // 4 of 5 triggered = 0.8, which is >= 0.8 - 0.1 = 0.7
    const skillRecords = [
      ...sessionIds
        .slice(0, 4)
        .map((sid) => makeSkillUsageRecord({ session_id: sid, triggered: true })),
      makeSkillUsageRecord({ session_id: sessionIds[4], triggered: false }),
    ];

    const queryRecords = sessionIds.map(
      (sid) =>
        ({
          timestamp: "2026-03-14T12:00:00Z",
          session_id: sid,
          query: "run tests",
        }) as QueryLogRecord,
    );

    // Write deployed audit entry to SQLite
    appendAuditEntry({
      timestamp: "2026-03-14T10:00:00Z",
      proposal_id: "evo-autonomy-proof-001",
      action: "deployed",
      details: "Deployed test-autonomy proposal",
      skill_name: "test-autonomy",
      eval_snapshot: { total: 10, passed: 8, failed: 2, pass_rate: 0.8 },
    });

    const telemetryPath = join(tmpDir, "stable-telemetry.jsonl");
    const skillLogPath = join(tmpDir, "stable-skill.jsonl");
    const queryLogPath = join(tmpDir, "stable-queries.jsonl");

    writeJsonl(telemetry, telemetryPath);
    writeJsonl(skillRecords, skillLogPath);
    writeJsonl(queryRecords, queryLogPath);

    const result: WatchResult = await watch({
      skillName: "test-autonomy",
      skillPath: "/tmp/skills/test-autonomy/SKILL.md",
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: false,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
    } as unknown as WatchOptions);

    expect(result.snapshot.regression_detected).toBe(false);
    expect(result.alert).toBeNull();
    expect(result.recommendation).toContain("stable");
  });
});

// ===========================================================================
// SCENARIO 3: Automatic rollback on regression
// ===========================================================================

describe("autonomy proof: automatic rollback on regression", () => {
  test("full cycle: deploy → regression → auto-rollback restores SKILL.md", async () => {
    // --- Step 1: Set up SKILL.md and deploy a proposal (real file I/O) ---
    const skillDir = join(tmpDir, "skills", "test-autonomy");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const auditLogPath = join(tmpDir, "rollback_audit.jsonl");

    writeFileSync(skillPath, SKILL_MD_ORIGINAL, "utf-8");

    const proposal = makeProposal(skillPath);

    // Run evolve with real file I/O to deploy
    const evolveResult = await evolve(
      {
        skillName: "test-autonomy",
        skillPath,
        agent: "claude",
        dryRun: false,
        confidenceThreshold: 0.6,
        maxIterations: 1,
      },
      {
        extractFailurePatterns: () => [makeFailurePattern()],
        generateProposal: async () => proposal,
        validateProposal: async () => makeValidation(),
        appendAuditEntry: (entry) => appendAuditEntry(entry),
        appendEvidenceEntry: () => {},
        buildEvalSet: () => makeEvalSet(),
        updateContextAfterEvolve: () => {},
        readSkillUsageLog: () => [],
      },
    );

    // Verify deploy happened
    expect(evolveResult.deployed).toBe(true);
    const deployedContent = readFileSync(skillPath, "utf-8");
    expect(deployedContent).toContain("flaky test diagnosis");
    expect(deployedContent).toContain("coverage analysis");
    expect(existsSync(`${skillPath}.bak`)).toBe(true);

    // --- Step 2: Simulate post-deploy regression via watch ---
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-autoroll-${i}`);

    const telemetry = sessionIds.map((sid) => makeTelemetryRecord({ session_id: sid }));

    // Severe regression: 0 of 10 triggered
    const skillRecords = sessionIds.map((sid) =>
      makeSkillUsageRecord({ session_id: sid, triggered: false }),
    );

    const queryRecords = sessionIds.map(
      (sid) =>
        ({
          timestamp: "2026-03-14T12:00:00Z",
          session_id: sid,
          query: "run tests",
        }) as QueryLogRecord,
    );

    const telemetryPath = join(tmpDir, "autoroll-telemetry.jsonl");
    const skillLogPath = join(tmpDir, "autoroll-skill.jsonl");
    const queryLogPath = join(tmpDir, "autoroll-queries.jsonl");

    writeJsonl(telemetry, telemetryPath);
    writeJsonl(skillRecords, skillLogPath);
    writeJsonl(queryRecords, queryLogPath);

    // --- Step 3: Watch with autoRollback=true and real rollback function ---
    const watchResult: WatchResult = await watch({
      skillName: "test-autonomy",
      skillPath,
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: true,
      _telemetryLogPath: telemetryPath,
      _skillLogPath: skillLogPath,
      _queryLogPath: queryLogPath,
      _auditLogPath: auditLogPath,
      _rollbackFn: async (opts) => {
        // Use the real rollback function.
        // Omit proposalId so rollback uses the .bak file strategy (latest deploy).
        return rollback({
          skillName: opts.skillName,
          skillPath: opts.skillPath,
        });
      },
    } as unknown as WatchOptions);

    // --- Assert: regression detected ---
    expect(watchResult.snapshot.regression_detected).toBe(true);
    expect(watchResult.snapshot.pass_rate).toBe(0);
    expect(watchResult.alert).not.toBeNull();

    // --- Assert: rollback executed ---
    expect(watchResult.rolledBack).toBe(true);
    expect(watchResult.recommendation).toContain("Rolled back");

    // --- Assert: SKILL.md restored to original content ---
    const restoredContent = readFileSync(skillPath, "utf-8");
    expect(restoredContent).toBe(SKILL_MD_ORIGINAL);

    // --- Assert: backup file consumed ---
    expect(existsSync(`${skillPath}.bak`)).toBe(false);

    // --- Assert: audit trail records the full lifecycle ---
    const auditEntries2 = readAuditTrail();
    const actions = auditEntries2.map((e) => e.action);
    expect(actions).toContain("created");
    expect(actions).toContain("validated");
    expect(actions).toContain("deployed");
    expect(actions).toContain("rolled_back");
  });

  test("auto-rollback does NOT fire when skill is stable", async () => {
    const skillDir = join(tmpDir, "skills", "stable-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const auditLogPath = join(tmpDir, "stable-rollback-audit.jsonl");

    // Deploy
    writeFileSync(skillPath, SKILL_MD_ORIGINAL, "utf-8");
    const proposal = makeProposal(skillPath);

    await evolve(
      {
        skillName: "test-autonomy",
        skillPath,
        agent: "claude",
        dryRun: false,
        confidenceThreshold: 0.6,
        maxIterations: 1,
      },
      {
        extractFailurePatterns: () => [makeFailurePattern()],
        generateProposal: async () => ({ ...proposal, skill_path: skillPath }),
        validateProposal: async () => makeValidation(),
        appendAuditEntry: (entry) => appendAuditEntry(entry),
        appendEvidenceEntry: () => {},
        buildEvalSet: () => makeEvalSet(),
        updateContextAfterEvolve: () => {},
        readSkillUsageLog: () => [],
      },
    );

    // Post-deploy: skill performing well (8/10 triggered)
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-ok-${i}`);
    const telemetry = sessionIds.map((sid) =>
      makeTelemetryRecord({ session_id: sid, skills_triggered: ["test-autonomy"] }),
    );
    const skillRecords = sessionIds.map((sid, i) =>
      makeSkillUsageRecord({ session_id: sid, triggered: i < 8 }),
    );
    const queryRecords = sessionIds.map(
      (sid) =>
        ({
          timestamp: "2026-03-14T12:00:00Z",
          session_id: sid,
          query: "run tests",
        }) as QueryLogRecord,
    );

    writeJsonl(telemetry, join(tmpDir, "ok-telemetry.jsonl"));
    writeJsonl(skillRecords, join(tmpDir, "ok-skill.jsonl"));
    writeJsonl(queryRecords, join(tmpDir, "ok-queries.jsonl"));

    let rollbackWasCalled = false;

    const watchResult: WatchResult = await watch({
      skillName: "test-autonomy",
      skillPath,
      windowSessions: 20,
      regressionThreshold: 0.1,
      autoRollback: true,
      _telemetryLogPath: join(tmpDir, "ok-telemetry.jsonl"),
      _skillLogPath: join(tmpDir, "ok-skill.jsonl"),
      _queryLogPath: join(tmpDir, "ok-queries.jsonl"),
      _auditLogPath: auditLogPath,
      _rollbackFn: async () => {
        rollbackWasCalled = true;
        return { rolledBack: false, restoredDescription: "", reason: "should not be called" };
      },
    } as unknown as WatchOptions);

    expect(watchResult.snapshot.regression_detected).toBe(false);
    expect(watchResult.rolledBack).toBe(false);
    expect(rollbackWasCalled).toBe(false);

    // SKILL.md still has the evolved content
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("flaky test diagnosis");
  });
});

// ===========================================================================
// SCENARIO 4: Full orchestrate loop with watch phase
// ===========================================================================

describe("autonomy proof: orchestrate watches recently-evolved skills", () => {
  test("orchestrate runs watch on skills from the audit log", async () => {
    const recentTimestamp = new Date().toISOString();
    let watchWasCalled = false;
    let watchSkillName = "";

    const deps: OrchestrateDeps = {
      syncSources: () => makeSyncResult(),
      computeStatus: () => makeStatusResult([]),
      detectAgent: () => "claude",
      doctor: () => makeDoctorResult(),
      readTelemetry: () => [],
      readSkillRecords: () => [],
      readQueryRecords: () => [],
      readAuditEntries: () => [
        {
          timestamp: recentTimestamp,
          proposal_id: "evo-recently-deployed",
          action: "deployed" as const,
          details: "deployed",
          skill_name: "recently-deployed-skill",
        },
      ],
      resolveSkillPath: (name) =>
        name === "recently-deployed-skill"
          ? "/tmp/skills/recently-deployed-skill/SKILL.md"
          : undefined,
      readGradingResults: () => [],
      readAlphaIdentity: () => null,
      evolve: async () => ({
        proposal: null,
        validation: null,
        deployed: false,
        auditEntries: [],
        reason: "no candidates",
        llmCallCount: 0,
        elapsedMs: 50,
      }),
      watch: async (opts) => {
        watchWasCalled = true;
        watchSkillName = opts.skillName;
        return {
          snapshot: {
            timestamp: new Date().toISOString(),
            skill_name: opts.skillName,
            window_sessions: 20,
            skill_checks: 10,
            pass_rate: 0.85,
            false_negative_rate: 0.15,
            by_invocation_type: {
              explicit: { passed: 5, total: 5 },
              implicit: { passed: 4, total: 5 },
              contextual: { passed: 0, total: 0 },
              negative: { passed: 0, total: 0 },
            },
            regression_detected: false,
            baseline_pass_rate: 0.8,
          },
          alert: null,
          rolledBack: false,
          recommendation: `Skill "${opts.skillName}" is stable.`,
        };
      },
    };

    const result = await orchestrate(
      {
        dryRun: false,
        approvalMode: "auto",
        maxSkills: 5,
        recentWindowHours: 48,
        syncForce: false,
      },
      deps,
    );

    expect(watchWasCalled).toBe(true);
    expect(watchSkillName).toBe("recently-deployed-skill");
    expect(result.summary.watched).toBe(1);

    const watchCandidate = result.candidates.find(
      (c) => c.skill === "recently-deployed-skill" && c.action === "watch",
    );
    expect(watchCandidate).toBeDefined();
    expect(watchCandidate?.reason).toContain("stable");
  });
});

// ===========================================================================
// SCENARIO 5: Candidate selection priority ordering
// ===========================================================================

describe("autonomy proof: candidate selection respects priority", () => {
  test("CRITICAL skills are selected before WARNING and UNGRADED", () => {
    const skills = [
      makeSkill({ name: "ungraded-skill", status: "UNGRADED", passRate: null, missedQueries: 2 }),
      makeSkill({ name: "warning-skill", status: "WARNING", passRate: 0.5, missedQueries: 3 }),
      makeSkill({ name: "critical-skill", status: "CRITICAL", passRate: 0.1, missedQueries: 10 }),
      makeSkill({ name: "healthy-skill", status: "HEALTHY", passRate: 0.95, missedQueries: 0 }),
    ];

    const result = selectCandidates(skills, { maxSkills: 2 });

    const evolveSkills = result.filter((r) => r.action === "evolve").map((r) => r.skill);
    const skipSkills = result.filter((r) => r.action === "skip").map((r) => r.skill);

    // CRITICAL should be first, WARNING second, both evolved
    expect(evolveSkills[0]).toBe("critical-skill");
    expect(evolveSkills[1]).toBe("warning-skill");

    // UNGRADED and HEALTHY should be skipped (max-skills cap / healthy)
    expect(skipSkills).toContain("healthy-skill");
    expect(skipSkills).toContain("ungraded-skill");
  });
});
