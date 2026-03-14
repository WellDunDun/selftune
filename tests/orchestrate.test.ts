import { describe, expect, test } from "bun:test";
import {
  type OrchestrateDeps,
  type OrchestrateOptions,
  orchestrate,
  selectCandidates,
} from "../cli/selftune/orchestrate.js";
import type { SkillStatus, StatusResult } from "../cli/selftune/status.js";
import type { SyncResult, SyncStepResult } from "../cli/selftune/sync.js";
import type { DoctorResult } from "../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<SkillStatus> = {}): SkillStatus {
  return {
    name: "TestSkill",
    passRate: 0.8,
    trend: "stable",
    missedQueries: 0,
    status: "HEALTHY",
    snapshot: null,
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
