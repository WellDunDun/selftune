import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, _setTestDb } from "../../packages/runtime/localdb/db.js";
import {
  collectPackageSearchEligibleSkills,
  prepareOrchestrateRun,
} from "@selftune/orchestration/orchestrate/prepare";
import { writeCanonicalPackageEvaluationArtifact } from "../../packages/runtime/testing-readiness.js";
import type { ResolvedOrchestrateRuntime } from "@selftune/orchestration/orchestrate/runtime";
import type { OrchestrateOptions } from "@selftune/orchestration/orchestrate";

let tempConfigDir = "";

function makeRuntime(): ResolvedOrchestrateRuntime {
  return {
    syncSources: async () => ({
      since: null,
      dry_run: false,
      sources: {
        claude: { available: false, scanned: 0, synced: 0, skipped: 0 },
        codex: { available: false, scanned: 0, synced: 0, skipped: 0 },
        opencode: { available: false, scanned: 0, synced: 0, skipped: 0 },
        openclaw: { available: false, scanned: 0, synced: 0, skipped: 0 },
        pi: { available: false, scanned: 0, synced: 0, skipped: 0 },
      },
      repair: {
        ran: false,
        repaired_sessions: 0,
        repaired_records: 0,
        codex_repaired_records: 0,
      },
      creator_contributions: {
        ran: false,
        eligible_skills: 0,
        built_signals: 0,
        staged_signals: 0,
      },
      timings: [],
      total_elapsed_ms: 0,
    }),
    computeStatus: () => ({
      skills: [
        {
          name: "PkgSkill",
          passRate: 0.2,
          trend: "down",
          missedQueries: 5,
          status: "CRITICAL",
          snapshot: {
            timestamp: "2026-04-15T00:00:00.000Z",
            skill_name: "PkgSkill",
            window_sessions: 20,
            skill_checks: 5,
            pass_rate: 0.2,
            false_negative_rate: 0.8,
            by_invocation_type: {
              explicit: { passed: 1, total: 3 },
              implicit: { passed: 0, total: 2 },
              contextual: { passed: 0, total: 0 },
              negative: { passed: 0, total: 0 },
            },
            regression_detected: true,
            baseline_pass_rate: 0.8,
          },
        },
      ],
      unmatchedQueries: 0,
      pendingProposals: 0,
      lastSession: null,
      system: { healthy: true, pass: 1, fail: 0, warn: 0 },
    }),
    evolve: async () => {
      throw new Error("not used");
    },
    watch: async () => {
      throw new Error("not used");
    },
    detectAgent: () => null,
    doctor: async () => ({ ok: true, errors: [], warnings: [] }),
    readTelemetry: () => [],
    readSkillRecords: () => [],
    readQueryRecords: () => [],
    readAuditEntries: () => [],
    resolveSkillPath: () => "/tmp/PkgSkill/SKILL.md",
    readGradingResults: () => [],
    readSignals: undefined,
    readAlphaIdentity: () => null,
    discoverWorkflowSkillProposals: () => [],
    persistWorkflowSkillProposal: () => undefined,
    buildReplayOptions: () => undefined,
  };
}

beforeEach(() => {
  tempConfigDir = mkdtempSync(join(tmpdir(), "selftune-orchestrate-prepare-"));
  process.env.SELFTUNE_CONFIG_DIR = tempConfigDir;
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  delete process.env.SELFTUNE_CONFIG_DIR;
  _setTestDb(null);
  if (tempConfigDir) {
    rmSync(tempConfigDir, { recursive: true, force: true });
    tempConfigDir = "";
  }
});

describe("prepareOrchestrateRun package-search eligibility", () => {
  test("routes skills with canonical package evaluation evidence into package-search", async () => {
    writeCanonicalPackageEvaluationArtifact("PkgSkill", {
      summary: {
        skill_name: "PkgSkill",
        skill_path: "/tmp/PkgSkill/SKILL.md",
        mode: "package",
        status: "passed",
        evaluation_passed: true,
        next_command: null,
        evaluation_source: "fresh",
        replay: {
          mode: "package",
          validation_mode: "host_replay",
          agent: "claude",
          proposal_id: null,
          fixture_id: null,
          total: 1,
          passed: 1,
          failed: 0,
          pass_rate: 1,
        },
        baseline: {
          mode: "package",
          baseline_pass_rate: 0.4,
          with_skill_pass_rate: 0.9,
          lift: 0.5,
          adds_value: true,
          measured_at: "2026-04-15T00:00:00.000Z",
        },
      },
      replay: {
        skill: "PkgSkill",
        skill_path: "/tmp/PkgSkill/SKILL.md",
        mode: "package",
        agent: "claude",
        proposal_id: null,
        total: 1,
        passed: 1,
        failed: 0,
        pass_rate: 1,
        fixture_id: null,
        results: [],
      },
      baseline: {
        skill_name: "PkgSkill",
        mode: "package",
        baseline_pass_rate: 0.4,
        with_skill_pass_rate: 0.9,
        lift: 0.5,
        adds_value: true,
        per_entry: [],
        measured_at: "2026-04-15T00:00:00.000Z",
      },
    });

    const result = await prepareOrchestrateRun(
      {
        dryRun: false,
        approvalMode: "auto",
        maxSkills: 5,
        recentWindowHours: 48,
        syncForce: false,
        maxAutoGrade: 0,
      } satisfies OrchestrateOptions,
      makeRuntime(),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.action).toBe("package-search");
  });
});

function insertGradingRows(db: ReturnType<typeof openDb>, skillName: string, count: number) {
  for (let i = 0; i < count; i++) {
    db.run(
      `INSERT OR IGNORE INTO grading_results
        (grading_id, session_id, skill_name, transcript_path, graded_at,
         pass_rate, passed_count, failed_count, total_count,
         expectations_json, claims_json, eval_feedback_json, execution_metrics_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `gr_test_${skillName}_${i}`,
        `sess_${i}`,
        skillName,
        "/tmp/transcript.md",
        new Date().toISOString(),
        0.5,
        1,
        1,
        2,
        "[]",
        "[]",
        "{}",
        "{}",
      ],
    );
  }
}

describe("collectPackageSearchEligibleSkills broader eligibility", () => {
  let draftSkillDir: string;

  beforeEach(() => {
    draftSkillDir = join(tempConfigDir, "draft-skill");
    mkdirSync(draftSkillDir, { recursive: true });
    writeFileSync(join(draftSkillDir, "SKILL.md"), "# DraftSkill\n");
    writeFileSync(join(draftSkillDir, "selftune.create.json"), "{}");
  });

  test("skill with draft package and >= 3 grading results is eligible", () => {
    const db = openDb(":memory:");
    _setTestDb(db);

    insertGradingRows(db, "DraftSkill", 3);

    const eligible = collectPackageSearchEligibleSkills(["DraftSkill"], {
      db,
      resolveSkillPath: (name) =>
        name === "DraftSkill" ? join(draftSkillDir, "SKILL.md") : undefined,
    });

    expect(eligible.has("DraftSkill")).toBe(true);
  });

  test("skill with draft package but < 3 grading results is NOT eligible", () => {
    const db = openDb(":memory:");
    _setTestDb(db);

    insertGradingRows(db, "DraftSkill", 2);

    const eligible = collectPackageSearchEligibleSkills(["DraftSkill"], {
      db,
      resolveSkillPath: (name) =>
        name === "DraftSkill" ? join(draftSkillDir, "SKILL.md") : undefined,
    });

    expect(eligible.has("DraftSkill")).toBe(false);
  });

  test("skill without draft package is NOT eligible via second tier", () => {
    const db = openDb(":memory:");
    _setTestDb(db);

    const noDraftDir = join(tempConfigDir, "no-draft-skill");
    mkdirSync(noDraftDir, { recursive: true });
    writeFileSync(join(noDraftDir, "SKILL.md"), "# NoDraft\n");

    insertGradingRows(db, "NoDraft", 5);

    const eligible = collectPackageSearchEligibleSkills(["NoDraft"], {
      db,
      resolveSkillPath: (name) => (name === "NoDraft" ? join(noDraftDir, "SKILL.md") : undefined),
    });

    expect(eligible.has("NoDraft")).toBe(false);
  });

  test("falls back gracefully when no db/resolveSkillPath provided", () => {
    const eligible = collectPackageSearchEligibleSkills(["DraftSkill"]);
    expect(eligible.has("DraftSkill")).toBe(false);
  });
});
