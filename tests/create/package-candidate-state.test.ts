import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "bun:sqlite";

import { openDb, _setTestDb } from "../../packages/runtime/localdb/db.js";
import {
  refreshPackageCandidateEvaluationObservation,
  listAcceptedPackageCandidates,
  listAcceptedPackageFrontierCandidates,
  listPackageCandidates,
  persistPackageCandidateEvaluation,
  readPackageCandidateArtifact,
  readPackageCandidateArtifactByFingerprint,
  selectAcceptedPackageFrontierCandidate,
} from "../../packages/runtime/create/package-candidate-state.js";

let db: Database;
let tempRoot: string;
let originalConfigDir: string | undefined;

function makeEvaluation(
  packageFingerprint: string,
  options: {
    status?: "passed" | "replay_failed" | "baseline_failed";
    evaluationSource?: "fresh" | "artifact_cache";
    skillName?: string;
    replayPassRate?: number;
    baselineLift?: number;
    bodyQualityScore?: number;
    unitTestPassRate?: number;
    gradingPassRateDelta?: number | null;
    gradingRecentPassRate?: number | null;
    gradingRegressed?: boolean | null;
    watchAlert?: string | null;
    watchRolledBack?: boolean;
  } = {},
) {
  const skillName = options.skillName ?? "research-assistant";
  const replayPassRate = options.replayPassRate ?? 1;
  const baselineLift = options.baselineLift ?? 0.5;
  const bodyQualityScore = options.bodyQualityScore ?? 0.9;
  const unitTestPassRate = options.unitTestPassRate ?? 1;
  const totalUnitTests = 4;
  const passedUnitTests = Math.round(unitTestPassRate * totalUnitTests);
  const failedUnitTests = totalUnitTests - passedUnitTests;
  return {
    summary: {
      skill_name: skillName,
      skill_path: `/tmp/${skillName}/SKILL.md`,
      mode: "package" as const,
      package_fingerprint: packageFingerprint,
      evaluation_source: options.evaluationSource ?? "fresh",
      status: options.status ?? "passed",
      evaluation_passed: (options.status ?? "passed") === "passed",
      next_command: null,
      replay: {
        mode: "package" as const,
        validation_mode: "host_replay" as const,
        agent: "claude",
        proposal_id: "proposal-with-skill",
        fixture_id: "fixture-package",
        total: 2,
        passed: replayPassRate === 1 ? 2 : 1,
        failed: replayPassRate === 1 ? 0 : 1,
        pass_rate: replayPassRate,
      },
      baseline: {
        mode: "package" as const,
        baseline_pass_rate: 0.5,
        with_skill_pass_rate: 0.5 + baselineLift,
        lift: baselineLift,
        adds_value: baselineLift > 0,
        measured_at: "2026-04-15T09:00:00.000Z",
      },
      body: {
        structural_valid: true,
        structural_reason: "Structural validation passed",
        quality_score: bodyQualityScore,
        quality_reason: "Clear body.",
        quality_threshold: 0.6,
        quality_passed: bodyQualityScore >= 0.6,
        valid: bodyQualityScore >= 0.6,
      },
      unit_tests: {
        total: totalUnitTests,
        passed: passedUnitTests,
        failed: failedUnitTests,
        pass_rate: unitTestPassRate,
        run_at: "2026-04-15T09:10:00.000Z",
        failing_tests: [],
      },
      ...(options.gradingPassRateDelta != null ||
      options.gradingRecentPassRate != null ||
      options.gradingRegressed != null
        ? {
            grading: {
              baseline: {
                proposal_id: "proposal-baseline",
                measured_at: "2026-04-15T08:00:00.000Z",
                pass_rate: 0.7,
                mean_score: 0.8,
                sample_size: 6,
              },
              recent: {
                sample_size: 6,
                average_pass_rate: options.gradingRecentPassRate ?? 0.7,
                average_mean_score: 0.82,
                newest_graded_at: "2026-04-15T09:30:00.000Z",
                oldest_graded_at: "2026-04-15T09:00:00.000Z",
              },
              pass_rate_delta: options.gradingPassRateDelta ?? null,
              mean_score_delta: null,
              regressed: options.gradingRegressed ?? null,
            },
          }
        : {}),
      ...(options.watchAlert != null || options.watchRolledBack
        ? {
            watch: {
              snapshot: {
                timestamp: "2026-04-15T10:00:00.000Z",
                skill_name: skillName,
                window_sessions: 6,
                skill_checks: 6,
                pass_rate: 5 / 6,
                false_negative_rate: 0,
                by_invocation_type: {
                  explicit: { passed: 2, total: 2 },
                  implicit: { passed: 2, total: 2 },
                  contextual: { passed: 1, total: 1 },
                  negative: { passed: 0, total: 1 },
                },
                regression_detected: options.watchAlert != null,
                baseline_pass_rate: 0.9,
              },
              alert: options.watchAlert ?? null,
              rolled_back: options.watchRolledBack ?? false,
              recommendation: options.watchAlert ? "rollback" : "continue",
              recommended_command: options.watchAlert
                ? `selftune rollback --skill ${skillName}`
                : null,
              grade_alert: null,
              grade_regression: null,
            },
          }
        : {}),
    },
    replay: {
      skill: skillName,
      skill_path: `/tmp/${skillName}/SKILL.md`,
      mode: "package" as const,
      agent: "claude",
      proposal_id: "proposal-with-skill",
      total: 2,
      passed: replayPassRate === 1 ? 2 : 1,
      failed: replayPassRate === 1 ? 0 : 1,
      pass_rate: replayPassRate,
      fixture_id: "fixture-package",
      results: [],
    },
    baseline: {
      skill_name: skillName,
      mode: "package" as const,
      baseline_pass_rate: 0.5,
      with_skill_pass_rate: 0.5 + baselineLift,
      lift: baselineLift,
      adds_value: baselineLift > 0,
      per_entry: [],
      measured_at: "2026-04-15T09:00:00.000Z",
    },
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  _setTestDb(db);
  tempRoot = mkdtempSync(join(tmpdir(), "selftune-package-candidates-"));
  originalConfigDir = process.env.SELFTUNE_CONFIG_DIR;
  process.env.SELFTUNE_CONFIG_DIR = join(tempRoot, ".selftune");
});

afterEach(() => {
  _setTestDb(null);
  if (originalConfigDir === undefined) delete process.env.SELFTUNE_CONFIG_DIR;
  else process.env.SELFTUNE_CONFIG_DIR = originalConfigDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("package candidate state", () => {
  it("creates a root candidate with a candidate-specific archived evaluation artifact", () => {
    const persisted = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_rootcandidate1234"),
      db,
    );

    expect(persisted.summary.candidate_id).toMatch(/^pkgcand_research-assistant_/);
    expect(persisted.summary.parent_candidate_id).toBeNull();
    expect(persisted.summary.candidate_generation).toBe(0);
    expect(persisted.summary.candidate_acceptance).toEqual({
      decision: "root",
      compared_to_candidate_id: null,
      decided_at: persisted.summary.candidate_acceptance?.decided_at,
      rationale: "Initial measured package candidate for this skill.",
      replay_pass_rate_delta: null,
      routing_pass_rate_delta: null,
      baseline_lift_delta: null,
      body_quality_delta: null,
      unit_test_pass_rate_delta: null,
    });

    const candidates = listPackageCandidates("research-assistant", db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.candidate_id).toBe(persisted.summary.candidate_id);
    expect(candidates[0]?.latest_acceptance_decision).toBe("root");
    expect(candidates[0]?.artifact_path).toContain(`${persisted.summary.candidate_id}.json`);
    expect(
      readPackageCandidateArtifact("research-assistant", persisted.summary.candidate_id!),
    ).toEqual(persisted);
  });

  it("links a new fingerprint to the latest candidate as its parent", () => {
    const root = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_rootcandidate1234"),
      db,
    );
    const child = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_childcandidate5678", {
        baselineLift: 0.7,
        bodyQualityScore: 0.95,
      }),
      db,
    );

    expect(child.summary.parent_candidate_id).toBe(root.summary.candidate_id);
    expect(child.summary.candidate_generation).toBe(1);
    expect(child.summary.candidate_acceptance?.decision).toBe("accepted");
    expect(child.summary.candidate_acceptance?.compared_to_candidate_id).toBe(
      root.summary.candidate_id,
    );
    expect(child.summary.candidate_acceptance?.baseline_lift_delta).toBeCloseTo(0.2, 5);

    const candidates = listPackageCandidates("research-assistant", db);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.candidate_generation).toBe(0);
    expect(candidates[1]?.candidate_generation).toBe(1);
    expect(candidates[1]?.latest_acceptance_decision).toBe("accepted");
  });

  it("marks a child candidate rejected when measured package metrics regress", () => {
    const root = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_rootcandidate1234"),
      db,
    );
    const child = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_regressedcandidate4444", {
        replayPassRate: 0.5,
        baselineLift: 0.1,
        bodyQualityScore: 0.7,
        unitTestPassRate: 0.5,
      }),
      db,
    );

    expect(child.summary.parent_candidate_id).toBe(root.summary.candidate_id);
    expect(child.summary.candidate_acceptance?.decision).toBe("rejected");
    expect(child.summary.candidate_acceptance?.rationale).toContain("Measured regressions");
    expect(child.summary.candidate_acceptance?.replay_pass_rate_delta).toBeCloseTo(-0.5, 5);
    expect(child.summary.candidate_acceptance?.baseline_lift_delta).toBeCloseTo(-0.4, 5);
    expect(child.summary.candidate_acceptance?.body_quality_delta).toBeCloseTo(-0.2, 5);
    expect(child.summary.candidate_acceptance?.unit_test_pass_rate_delta).toBeCloseTo(-0.5, 5);

    const candidates = listPackageCandidates("research-assistant", db);
    expect(candidates[1]?.latest_acceptance_decision).toBe("rejected");
  });

  it("compares fresh candidates against the strongest accepted frontier member", () => {
    const root = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_rootcandidate1234"),
      db,
    );
    const rejected = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_regressedcandidate4444", {
        replayPassRate: 0.5,
        baselineLift: 0.1,
        bodyQualityScore: 0.7,
        unitTestPassRate: 0.5,
      }),
      db,
    );
    const improved = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_frontiercandidate2222", {
        replayPassRate: 1,
        baselineLift: 0.65,
        bodyQualityScore: 0.96,
        unitTestPassRate: 1,
      }),
      db,
    );

    expect(improved.summary.parent_candidate_id).toBe(rejected.summary.candidate_id);
    expect(improved.summary.candidate_acceptance?.compared_to_candidate_id).toBe(
      root.summary.candidate_id,
    );
    expect(improved.summary.candidate_acceptance?.decision).toBe("accepted");
    expect(improved.summary.candidate_acceptance?.baseline_lift_delta).toBeCloseTo(0.15, 5);
  });

  it("prefers the strongest measured accepted frontier member over the newest accepted candidate", () => {
    const root = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_rootcandidate1234"),
      db,
    );
    const strongest = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_frontierstrong1234", {
        baselineLift: 0.65,
        bodyQualityScore: 0.96,
        gradingPassRateDelta: 0.12,
        gradingRecentPassRate: 0.92,
        gradingRegressed: false,
      }),
      db,
    );
    const newerButNoisier = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_frontiernoisy5678", {
        baselineLift: 0.7,
        bodyQualityScore: 0.97,
        gradingPassRateDelta: -0.18,
        gradingRecentPassRate: 0.58,
        gradingRegressed: true,
      }),
      db,
    );
    const fresh = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_frontierfresh9999", {
        baselineLift: 0.75,
        bodyQualityScore: 0.99,
      }),
      db,
    );

    const acceptedFrontier = listAcceptedPackageFrontierCandidates("research-assistant", db);
    expect(acceptedFrontier.map((candidate) => candidate.candidate_id)).toEqual([
      strongest.summary.candidate_id,
      fresh.summary.candidate_id,
      root.summary.candidate_id,
      newerButNoisier.summary.candidate_id,
    ]);
    expect(selectAcceptedPackageFrontierCandidate("research-assistant", { db })?.candidate_id).toBe(
      strongest.summary.candidate_id,
    );
    expect(fresh.summary.parent_candidate_id).toBe(newerButNoisier.summary.candidate_id);
    expect(fresh.summary.candidate_acceptance?.compared_to_candidate_id).toBe(
      strongest.summary.candidate_id,
    );
  });

  it("reads accepted frontier candidates and fingerprint artifacts separately from rejected history", () => {
    persistPackageCandidateEvaluation(makeEvaluation("pkg_sha256_rootcandidate1234"), db);
    persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_regressedcandidate4444", {
        replayPassRate: 0.5,
        baselineLift: 0.1,
        bodyQualityScore: 0.7,
        unitTestPassRate: 0.5,
      }),
      db,
    );
    const accepted = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_frontiercandidate2222", {
        replayPassRate: 1,
        baselineLift: 0.65,
        bodyQualityScore: 0.96,
        unitTestPassRate: 1,
      }),
      db,
    );

    const acceptedFrontier = listAcceptedPackageCandidates("research-assistant", db);
    expect(acceptedFrontier).toHaveLength(2);
    expect(acceptedFrontier.map((candidate) => candidate.latest_acceptance_decision)).toEqual([
      "root",
      "accepted",
    ]);

    expect(
      readPackageCandidateArtifactByFingerprint(
        "research-assistant",
        "pkg_sha256_regressedcandidate4444",
        { acceptedOnly: true, db },
      ),
    ).toBeNull();
    expect(
      readPackageCandidateArtifactByFingerprint(
        "research-assistant",
        "pkg_sha256_frontiercandidate2222",
        { acceptedOnly: true, db },
      ),
    ).toEqual(accepted);
  });

  it("reuses the existing candidate row for the same fingerprint", () => {
    const first = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_repeatcandidate9999"),
      db,
    );
    const second = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_repeatcandidate9999", {
        status: "baseline_failed",
      }),
      db,
    );

    expect(second.summary.candidate_id).toBe(first.summary.candidate_id);
    expect(second.summary.candidate_generation).toBe(first.summary.candidate_generation);

    const candidates = listPackageCandidates("research-assistant", db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.evaluation_count).toBe(2);
    expect(candidates[0]?.latest_status).toBe("baseline_failed");
    expect(candidates[0]?.latest_acceptance_decision).toBe("root");
  });

  it("refreshes candidate observations without incrementing evaluation history and lets watch health steer frontier selection", () => {
    persistPackageCandidateEvaluation(makeEvaluation("pkg_sha256_rootcandidate1234"), db);
    const strongest = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_frontierstrong1234", {
        baselineLift: 0.7,
        bodyQualityScore: 0.97,
      }),
      db,
    );
    const fallback = persistPackageCandidateEvaluation(
      makeEvaluation("pkg_sha256_frontierfallback5678", {
        baselineLift: 0.72,
        bodyQualityScore: 0.98,
      }),
      db,
    );

    refreshPackageCandidateEvaluationObservation(
      {
        ...strongest,
        summary: {
          ...strongest.summary,
          watch: {
            snapshot: {
              timestamp: "2026-04-15T11:00:00.000Z",
              skill_name: "research-assistant",
              window_sessions: 8,
              skill_checks: 8,
              pass_rate: 0.5,
              false_negative_rate: 0.25,
              by_invocation_type: {
                explicit: { passed: 2, total: 3 },
                implicit: { passed: 1, total: 2 },
                contextual: { passed: 1, total: 1 },
                negative: { passed: 0, total: 2 },
              },
              regression_detected: true,
              baseline_pass_rate: 0.9,
            },
            alert: 'regression detected for "research-assistant"',
            rolled_back: true,
            recommendation: "rollback",
            recommended_command: "selftune rollback --skill research-assistant",
            grade_alert: null,
            grade_regression: null,
          },
        },
      },
      db,
    );

    const updatedStrongest = readPackageCandidateArtifact(
      "research-assistant",
      strongest.summary.candidate_id!,
    );
    expect(updatedStrongest?.summary.watch?.rolled_back).toBe(true);

    const candidates = listPackageCandidates("research-assistant", db);
    expect(
      candidates.find((candidate) => candidate.candidate_id === strongest.summary.candidate_id)
        ?.evaluation_count,
    ).toBe(1);
    expect(selectAcceptedPackageFrontierCandidate("research-assistant", { db })?.candidate_id).toBe(
      fallback.summary.candidate_id,
    );
  });
});
