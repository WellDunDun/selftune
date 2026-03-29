import { describe, expect, test } from "bun:test";

import type { EvolveOptions } from "../cli/selftune/evolution/evolve.js";
import {
  DEFAULT_COOLDOWN_HOURS,
  formatOrchestrateReport,
  MIN_CANDIDATE_EVIDENCE,
  type OrchestrateDeps,
  type OrchestrateOptions,
  type OrchestrateResult,
  orchestrate,
  selectCandidates,
} from "../cli/selftune/orchestrate.js";
import type { SkillStatus, StatusResult } from "../cli/selftune/status.js";
import type { SyncResult, SyncStepResult } from "../cli/selftune/sync.js";
import type {
  DoctorResult,
  EvolutionAuditEntry,
  MonitoringSnapshot,
} from "../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    timestamp: new Date().toISOString(),
    skill_name: "TestSkill",
    window_sessions: 20,
    skill_checks: 10,
    pass_rate: 0.8,
    false_negative_rate: 0.1,
    by_invocation_type: {
      explicit: { passed: 5, total: 5 },
      implicit: { passed: 3, total: 5 },
      contextual: { passed: 0, total: 0 },
      negative: { passed: 0, total: 0 },
    },
    regression_detected: false,
    baseline_pass_rate: 0.5,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    name: "TestSkill",
    passRate: 0.8,
    trend: "stable",
    missedQueries: 0,
    status: "HEALTHY",
    snapshot: makeSnapshot(),
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<EvolutionAuditEntry> = {}): EvolutionAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    proposal_id: "p-test",
    action: "deployed",
    details: "test deploy",
    ...overrides,
  };
}

function makeSyncResult(): SyncResult {
  const step: SyncStepResult = { available: true, scanned: 0, synced: 0, skipped: 0 };
  return {
    since: null,
    dry_run: false,
    sources: { claude: step, codex: step, opencode: step, openclaw: step },
    repair: { ran: true, repaired_sessions: 0, repaired_records: 0, codex_repaired_records: 0 },
    timings: [],
    total_elapsed_ms: 0,
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
    unmatchedQueries: 0,
    pendingProposals: 0,
    lastSession: null,
    system: { healthy: true, pass: 5, fail: 0, warn: 0 },
  };
}

const baseOptions: OrchestrateOptions = {
  dryRun: false,
  approvalMode: "auto",
  maxSkills: 5,
  recentWindowHours: 48,
  syncForce: false,
};

function makeDeps(overrides: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    syncSources: () => makeSyncResult(),
    computeStatus: () => makeStatusResult([]),
    detectAgent: () => "claude",
    doctor: () => makeDoctorResult(),
    readTelemetry: () => [],
    readSkillRecords: () => [],
    readQueryRecords: () => [],
    readAuditEntries: () => [],
    resolveSkillPath: () => "/fake/path/SKILL.md",
    readGradingResults: () => [],
    readAlphaIdentity: () => null,
    evolve: async () => ({
      proposal: null,
      validation: null,
      deployed: false,
      auditEntries: [],
      reason: "dry run",
      llmCallCount: 0,
      elapsedMs: 100,
    }),
    watch: async () => ({
      snapshot: {
        timestamp: new Date().toISOString(),
        skill_name: "test",
        window_sessions: 20,
        skill_checks: 10,
        pass_rate: 0.9,
        false_negative_rate: 0.1,
        by_invocation_type: {
          explicit: { passed: 5, total: 5 },
          implicit: { passed: 3, total: 5 },
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// selectCandidates
// ---------------------------------------------------------------------------

describe("selectCandidates", () => {
  test("selects CRITICAL skills for evolve", () => {
    const skills = [
      makeSkill({ name: "Bad", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("evolve");
    expect(result[0].reason).toContain("CRITICAL");
  });

  test("selects WARNING skills for evolve", () => {
    const skills = [
      makeSkill({ name: "Weak", status: "WARNING", passRate: 0.5, missedQueries: 3 }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("evolve");
  });

  test("selects UNGRADED skills with missed queries", () => {
    const skills = [
      makeSkill({ name: "New", status: "UNGRADED", passRate: null, missedQueries: 2 }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("evolve");
  });

  test("skips UNGRADED skills with 0 missed queries", () => {
    const skills = [
      makeSkill({ name: "New", status: "UNGRADED", passRate: null, missedQueries: 0 }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("skip");
    expect(result[0].reason).toContain("insufficient signal");
  });

  test("skips HEALTHY skills", () => {
    const skills = [makeSkill({ name: "Good", status: "HEALTHY" })];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("skip");
  });

  test("applies --skill filter", () => {
    const skills = [
      makeSkill({ name: "A", status: "CRITICAL", passRate: 0.1, missedQueries: 5 }),
      makeSkill({ name: "B", status: "CRITICAL", passRate: 0.2, missedQueries: 3 }),
    ];
    const result = selectCandidates(skills, { skillFilter: "B", maxSkills: 5 });
    const aAction = result.find((r) => r.skill === "A");
    const bAction = result.find((r) => r.skill === "B");
    expect(aAction?.action).toBe("skip");
    expect(bAction?.action).toBe("evolve");
  });

  test("caps at --max-skills", () => {
    const skills = [
      makeSkill({ name: "A", status: "CRITICAL", passRate: 0.1, missedQueries: 5 }),
      makeSkill({ name: "B", status: "CRITICAL", passRate: 0.2, missedQueries: 3 }),
      makeSkill({ name: "C", status: "WARNING", passRate: 0.5, missedQueries: 2 }),
    ];
    const result = selectCandidates(skills, { maxSkills: 2 });
    const evolveCount = result.filter((r) => r.action === "evolve").length;
    expect(evolveCount).toBe(2);
    const cAction = result.find((r) => r.skill === "C");
    expect(cAction?.action).toBe("skip");
    expect(cAction?.reason).toContain("max-skills");
  });

  test("skips skills on cooldown (recently deployed)", () => {
    const recentTimestamp = new Date().toISOString();
    const skills = [
      makeSkill({ name: "Hot", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
    ];
    const auditEntries = [makeAuditEntry({ skill_name: "Hot", timestamp: recentTimestamp })];
    const result = selectCandidates(skills, { maxSkills: 5, auditEntries });
    expect(result[0].action).toBe("skip");
    expect(result[0].reason).toContain("recently evolved");
  });

  test("allows skills past cooldown window", () => {
    const oldTimestamp = new Date(
      Date.now() - (DEFAULT_COOLDOWN_HOURS + 1) * 60 * 60 * 1000,
    ).toISOString();
    const skills = [
      makeSkill({ name: "Stale", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
    ];
    const auditEntries = [makeAuditEntry({ skill_name: "Stale", timestamp: oldTimestamp })];
    const result = selectCandidates(skills, { maxSkills: 5, auditEntries });
    expect(result[0].action).toBe("evolve");
  });

  test("skips CRITICAL/WARNING with insufficient evidence", () => {
    const skills = [
      makeSkill({
        name: "Sparse",
        status: "WARNING",
        passRate: 0.5,
        missedQueries: 2,
        snapshot: makeSnapshot({ skill_checks: 1 }),
      }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("skip");
    expect(result[0].reason).toContain("insufficient evidence");
  });

  test("allows skills with enough evidence", () => {
    const skills = [
      makeSkill({
        name: "Rich",
        status: "WARNING",
        passRate: 0.5,
        missedQueries: 2,
        snapshot: makeSnapshot({ skill_checks: MIN_CANDIDATE_EVIDENCE }),
      }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("evolve");
  });

  test("skips WARNING with no missed queries and stable trend (weak signal)", () => {
    const skills = [
      makeSkill({
        name: "Noisy",
        status: "WARNING",
        passRate: 0.55,
        missedQueries: 0,
        trend: "stable",
      }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("skip");
    expect(result[0].reason).toContain("weak signal");
  });

  test("evolves WARNING with no missed queries but declining trend", () => {
    const skills = [
      makeSkill({
        name: "Declining",
        status: "WARNING",
        passRate: 0.55,
        missedQueries: 0,
        trend: "down",
      }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("evolve");
  });

  test("does not require evidence gate for UNGRADED skills", () => {
    const skills = [
      makeSkill({
        name: "New",
        status: "UNGRADED",
        passRate: null,
        missedQueries: 3,
        snapshot: makeSnapshot({ skill_checks: 1 }),
      }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].action).toBe("evolve");
  });

  test("declining trend boosts priority over stable", () => {
    const skills = [
      makeSkill({
        name: "Stable",
        status: "WARNING",
        passRate: 0.5,
        missedQueries: 3,
        trend: "stable",
      }),
      makeSkill({
        name: "Declining",
        status: "WARNING",
        passRate: 0.5,
        missedQueries: 3,
        trend: "down",
      }),
    ];
    const result = selectCandidates(skills, { maxSkills: 1 });
    const evolvedSkill = result.find((r) => r.action === "evolve");
    expect(evolvedSkill?.skill).toBe("Declining");
  });

  test("reason includes trend info for selected candidates", () => {
    const skills = [
      makeSkill({ name: "X", status: "CRITICAL", passRate: 0.2, missedQueries: 5, trend: "down" }),
    ];
    const result = selectCandidates(skills, { maxSkills: 5 });
    expect(result[0].reason).toContain("trend=down");
  });
});

// ---------------------------------------------------------------------------
// orchestrate
// ---------------------------------------------------------------------------

describe("orchestrate", () => {
  test("runs sync as mandatory first step", async () => {
    let syncCalled = false;
    const deps = makeDeps({
      syncSources: () => {
        syncCalled = true;
        return makeSyncResult();
      },
    });
    await orchestrate(baseOptions, deps);
    expect(syncCalled).toBe(true);
  });

  test("returns summary with correct counts for empty skill list", async () => {
    const result = await orchestrate(baseOptions, makeDeps());
    expect(result.summary.totalSkills).toBe(0);
    expect(result.summary.evaluated).toBe(0);
    expect(result.summary.skipped).toBe(0);
    expect(result.summary.dryRun).toBe(false);
    expect(result.summary.approvalMode).toBe("auto");
  });

  test("dry-run prevents deployment even when evolve would succeed", async () => {
    let evolveDryRun: boolean | undefined;
    const deps = makeDeps({
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "Skill1", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
        ]),
      evolve: async (opts) => {
        evolveDryRun = opts.dryRun;
        return {
          proposal: null,
          validation: null,
          deployed: false,
          auditEntries: [],
          reason: "dry run",
          llmCallCount: 0,
          elapsedMs: 50,
        };
      },
    });

    await orchestrate({ ...baseOptions, dryRun: true }, deps);
    expect(evolveDryRun).toBe(true);
  });

  test("autonomous mode passes dryRun=false to evolve", async () => {
    let evolveDryRun: boolean | undefined;
    const deps = makeDeps({
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "Skill1", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
        ]),
      evolve: async (opts) => {
        evolveDryRun = opts.dryRun;
        return {
          proposal: null,
          validation: null,
          deployed: false,
          auditEntries: [],
          reason: "no patterns",
          llmCallCount: 0,
          elapsedMs: 50,
        };
      },
    });

    await orchestrate({ ...baseOptions, dryRun: false, approvalMode: "auto" }, deps);
    expect(evolveDryRun).toBe(false);
  });

  test("autonomous mode passes the full loop-safe evolve defaults", async () => {
    let evolveOpts: EvolveOptions | undefined;
    const deps = makeDeps({
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "Skill1", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
        ]),
      evolve: async (opts) => {
        evolveOpts = opts;
        return {
          proposal: null,
          validation: null,
          deployed: false,
          auditEntries: [],
          reason: "no patterns",
          llmCallCount: 0,
          elapsedMs: 50,
        };
      },
    });

    await orchestrate({ ...baseOptions, dryRun: false, approvalMode: "auto" }, deps);

    expect(evolveOpts).toMatchObject({
      paretoEnabled: true,
      candidateCount: 3,
      tokenEfficiencyEnabled: false,
      withBaseline: false,
      validationModel: "haiku",
      cheapLoop: true,
      gateModel: "sonnet",
      adaptiveGate: true,
      proposalModel: "haiku",
      syncFirst: false,
    });
  });

  test("review-required mode keeps evolve in dry-run", async () => {
    let evolveDryRun: boolean | undefined;
    const deps = makeDeps({
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "Skill1", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
        ]),
      evolve: async (opts) => {
        evolveDryRun = opts.dryRun;
        return {
          proposal: null,
          validation: null,
          deployed: false,
          auditEntries: [],
          reason: "review required",
          llmCallCount: 0,
          elapsedMs: 50,
        };
      },
    });

    await orchestrate({ ...baseOptions, approvalMode: "review" }, deps);
    expect(evolveDryRun).toBe(true);
  });

  test("skips evolve when skill path cannot be resolved", async () => {
    const deps = makeDeps({
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "Missing", status: "CRITICAL", passRate: 0.1, missedQueries: 5 }),
        ]),
      resolveSkillPath: () => undefined,
    });

    const result = await orchestrate(baseOptions, deps);
    const missingCandidate = result.candidates.find((c) => c.skill === "Missing");
    expect(missingCandidate?.action).toBe("skip");
    expect(missingCandidate?.reason).toContain("SKILL.md not found");
  });

  test("watches recently evolved skills from audit log", async () => {
    let watchCalled = false;
    let watchAutoRollback: boolean | undefined;
    const recentTimestamp = new Date().toISOString();
    const deps = makeDeps({
      readAuditEntries: () => [
        {
          timestamp: recentTimestamp,
          proposal_id: "p1",
          action: "deployed" as const,
          details: "deployed",
          skill_name: "RecentSkill",
        },
      ],
      watch: async (opts) => {
        watchCalled = true;
        watchAutoRollback = opts.autoRollback;
        return {
          snapshot: {
            timestamp: new Date().toISOString(),
            skill_name: "RecentSkill",
            window_sessions: 20,
            skill_checks: 10,
            pass_rate: 0.9,
            false_negative_rate: 0.1,
            by_invocation_type: {
              explicit: { passed: 5, total: 5 },
              implicit: { passed: 3, total: 5 },
              contextual: { passed: 0, total: 0 },
              negative: { passed: 0, total: 0 },
            },
            regression_detected: false,
            baseline_pass_rate: 0.8,
          },
          alert: null,
          rolledBack: false,
          recommendation: "stable",
        };
      },
    });

    const result = await orchestrate(baseOptions, deps);
    expect(watchCalled).toBe(true);
    expect(watchAutoRollback).toBe(true);
    expect(result.summary.watched).toBe(1);
  });

  test("skips evolve when no agent CLI is available", async () => {
    const deps = makeDeps({
      computeStatus: () =>
        makeStatusResult([
          makeSkill({ name: "Skill1", status: "CRITICAL", passRate: 0.2, missedQueries: 5 }),
        ]),
      detectAgent: () => null,
    });

    const result = await orchestrate(baseOptions, deps);
    const candidate = result.candidates.find((c) => c.skill === "Skill1");
    expect(candidate?.action).toBe("skip");
    expect(candidate?.reason).toContain("no agent CLI");
  });
});

// ---------------------------------------------------------------------------
// formatOrchestrateReport
// ---------------------------------------------------------------------------

function makeOrchestrateResult(overrides: Partial<OrchestrateResult> = {}): OrchestrateResult {
  const step: SyncStepResult = { available: true, scanned: 10, synced: 2, skipped: 0 };
  return {
    syncResult: {
      since: null,
      dry_run: false,
      sources: {
        claude: step,
        codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
        opencode: { available: true, scanned: 5, synced: 0, skipped: 0 },
        openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
      },
      repair: { ran: true, repaired_sessions: 3, repaired_records: 7, codex_repaired_records: 0 },
      timings: [],
      total_elapsed_ms: 500,
    },
    statusResult: makeStatusResult([
      makeSkill({ name: "Research", status: "CRITICAL", passRate: 0.35, missedQueries: 8 }),
      makeSkill({ name: "Browser", status: "WARNING", passRate: 0.55, missedQueries: 3 }),
      makeSkill({ name: "Content", status: "HEALTHY", passRate: 0.9, missedQueries: 0 }),
    ]),
    candidates: [
      { skill: "Research", action: "evolve", reason: "status=CRITICAL, passRate=35%, missed=8" },
      { skill: "Browser", action: "evolve", reason: "status=WARNING, passRate=55%, missed=3" },
      { skill: "Content", action: "skip", reason: "status=HEALTHY — no action needed" },
    ],
    summary: {
      totalSkills: 3,
      evaluated: 2,
      evolved: 0,
      deployed: 0,
      watched: 0,
      skipped: 1,
      dryRun: true,
      approvalMode: "auto",
      elapsedMs: 1200,
    },
    ...overrides,
  };
}

describe("formatOrchestrateReport", () => {
  test("includes dry-run mode banner", () => {
    const report = formatOrchestrateReport(makeOrchestrateResult());
    expect(report).toContain("DRY RUN");
  });

  test("includes autonomous mode banner", () => {
    const report = formatOrchestrateReport(
      makeOrchestrateResult({
        summary: { ...makeOrchestrateResult().summary, dryRun: false, approvalMode: "auto" },
      }),
    );
    expect(report).toContain("AUTONOMOUS");
  });

  test("includes review mode banner", () => {
    const report = formatOrchestrateReport(
      makeOrchestrateResult({
        summary: { ...makeOrchestrateResult().summary, dryRun: false, approvalMode: "review" },
      }),
    );
    expect(report).toContain("REVIEW");
  });

  test("shows sync sources with availability", () => {
    const report = formatOrchestrateReport(makeOrchestrateResult());
    expect(report).toContain("Claude");
    expect(report).toContain("synced 2");
    expect(report).toContain("Codex");
    expect(report).toContain("not available");
    expect(report).toContain("OpenCode");
    expect(report).toContain("up to date");
  });

  test("shows repair info when records were repaired", () => {
    const report = formatOrchestrateReport(makeOrchestrateResult());
    expect(report).toContain("7 records across 3 sessions");
  });

  test("shows status breakdown by category", () => {
    const report = formatOrchestrateReport(makeOrchestrateResult());
    expect(report).toContain("1 CRITICAL");
    expect(report).toContain("1 WARNING");
    expect(report).toContain("1 HEALTHY");
  });

  test("lists each skill decision with action and reason", () => {
    const report = formatOrchestrateReport(makeOrchestrateResult());
    expect(report).toContain("Research");
    expect(report).toContain("EVOLVE");
    expect(report).toContain("status=CRITICAL");
    expect(report).toContain("Content");
    expect(report).toContain("SKIP");
    expect(report).toContain("no action needed");
  });

  test("includes evolution results when evolve ran", () => {
    const result = makeOrchestrateResult({
      candidates: [
        {
          skill: "Research",
          action: "evolve",
          reason: "status=CRITICAL",
          evolveResult: {
            proposal: null,
            validation: {
              proposal_id: "test-proposal",
              improved: true,
              before_pass_rate: 0.35,
              after_pass_rate: 0.7,
              net_change: 0.35,
              regressions: [],
              new_passes: [],
              per_entry_results: [],
            },
            deployed: true,
            auditEntries: [],
            reason: "Evolution deployed successfully",
            llmCallCount: 5,
            elapsedMs: 3000,
          },
        },
      ],
    });
    const report = formatOrchestrateReport(result);
    expect(report).toContain("Evolution Results");
    expect(report).toContain("deployed");
    expect(report).toContain("35%");
    expect(report).toContain("70%");
  });

  test("includes watch results with rollback info", () => {
    const result = makeOrchestrateResult({
      candidates: [
        {
          skill: "RecentSkill",
          action: "watch",
          reason: "regression detected",
          watchResult: {
            snapshot: {
              timestamp: new Date().toISOString(),
              skill_name: "RecentSkill",
              window_sessions: 20,
              skill_checks: 10,
              pass_rate: 0.4,
              false_negative_rate: 0.1,
              by_invocation_type: {
                explicit: { passed: 2, total: 5 },
                implicit: { passed: 1, total: 5 },
                contextual: { passed: 0, total: 0 },
                negative: { passed: 0, total: 0 },
              },
              regression_detected: true,
              baseline_pass_rate: 0.8,
            },
            alert: "pass rate dropped from 0.80 to 0.40",
            rolledBack: true,
            recommendation: "rollback",
          },
        },
      ],
    });
    const report = formatOrchestrateReport(result);
    expect(report).toContain("Watch");
    expect(report).toContain("RecentSkill");
    expect(report).toContain("[ALERT]");
    expect(report).toContain("[ROLLED BACK]");
    expect(report).toContain("pass_rate=0.40");
  });

  test("shows summary counts", () => {
    const report = formatOrchestrateReport(makeOrchestrateResult());
    expect(report).toContain("Evaluated:    2 skills");
    expect(report).toContain("Skipped:      1");
    expect(report).toContain("Elapsed:      1.2s");
  });

  test("omits evolution and watch phases when empty", () => {
    const result = makeOrchestrateResult({
      candidates: [{ skill: "Content", action: "skip", reason: "status=HEALTHY" }],
    });
    const report = formatOrchestrateReport(result);
    expect(report).not.toContain("Evolution Results");
    expect(report).not.toContain("Phase 5: Watch");
  });

  test("dry-run includes rerun hint", () => {
    const result = makeOrchestrateResult({
      summary: { ...makeOrchestrateResult().summary, dryRun: true, evaluated: 2 },
    });
    const report = formatOrchestrateReport(result);
    expect(report).toContain("Rerun without --dry-run");
  });

  test("review mode includes rerun hint", () => {
    const result = makeOrchestrateResult({
      summary: {
        ...makeOrchestrateResult().summary,
        dryRun: false,
        approvalMode: "review",
        evaluated: 2,
      },
    });
    const report = formatOrchestrateReport(result);
    expect(report).toContain("Rerun without --review-required");
  });

  test("shows (no skills to evaluate) when candidates empty", () => {
    const result = makeOrchestrateResult({ candidates: [] });
    const report = formatOrchestrateReport(result);
    expect(report).toContain("(no skills to evaluate)");
  });
});
