import type { Database } from "bun:sqlite";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import { getDb } from "../localdb/db.js";
import type {
  CreatePackageBodySummary,
  CreatePackageCandidateAcceptanceDecision,
  CreatePackageCandidateAcceptanceSummary,
  CreatePackageCandidateRecord,
} from "../types.js";
import {
  CreatePackageEvaluationResult,
  CreatePackageEvaluationSummary,
} from "../types/evaluation.js";

const PACKAGE_CANDIDATE_DIRNAME = "package-candidates";
const METRIC_EPSILON = 1e-9;

function sanitizeSkillName(skillName: string): string {
  return skillName.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
}

function getPackageCandidateRoot(
  configDir: string = process.env.SELFTUNE_CONFIG_DIR || SELFTUNE_CONFIG_DIR,
) {
  return join(configDir, PACKAGE_CANDIDATE_DIRNAME);
}

export function getPackageCandidateArtifactPath(
  skillName: string,
  candidateId: string,
  configDir: string = process.env.SELFTUNE_CONFIG_DIR || SELFTUNE_CONFIG_DIR,
): string {
  return join(
    getPackageCandidateRoot(configDir),
    sanitizeSkillName(skillName),
    `${candidateId}.json`,
  );
}

function getOptionalDb(): Database | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function buildCandidateId(skillName: string, packageFingerprint: string): string {
  const fingerprintSuffix = packageFingerprint
    .replace(/^pkg_sha256_/, "")
    .slice(0, 16)
    .padEnd(16, "0");
  return `pkgcand_${sanitizeSkillName(skillName)}_${fingerprintSuffix}`;
}

function readCandidateArtifact(path: string): CreatePackageEvaluationResult | null {
  try {
    if (!existsSync(path)) return null;
    return Schema.decodeUnknownSync(Schema.fromJsonString(CreatePackageEvaluationResult))(
      readFileSync(path, "utf-8"),
    );
  } catch {
    return null;
  }
}

function readCandidateArtifactForRecord(
  record: CreatePackageCandidateRecord,
): CreatePackageEvaluationResult | null {
  if (record.artifact_path) {
    const fromStoredPath = readCandidateArtifact(record.artifact_path);
    if (fromStoredPath) return fromStoredPath;
  }
  return readCandidateArtifact(
    getPackageCandidateArtifactPath(record.skill_name, record.candidate_id),
  );
}

type CandidateRow = {
  candidate_id: string;
  skill_name: string;
  skill_path: string;
  package_fingerprint: string;
  parent_candidate_id: string | null;
  candidate_generation: number;
  evaluation_count: number;
  first_evaluated_at: string;
  last_evaluated_at: string;
  latest_status: CreatePackageEvaluationSummary["status"];
  latest_evaluation_source: CreatePackageEvaluationSummary["evaluation_source"] | null;
  latest_acceptance_decision: CreatePackageCandidateAcceptanceDecision | null;
  artifact_path: string | null;
  summary_json: string;
};

type MetricComparison = {
  delta: number | null;
  improved: boolean;
  regressed: boolean;
};

function hydrateCandidateRow(row: CandidateRow): CreatePackageCandidateRecord | null {
  try {
    const summary = Schema.decodeUnknownSync(Schema.fromJsonString(CreatePackageEvaluationSummary))(
      row.summary_json,
    );
    return {
      candidate_id: row.candidate_id,
      skill_name: row.skill_name,
      skill_path: row.skill_path,
      package_fingerprint: row.package_fingerprint,
      parent_candidate_id: row.parent_candidate_id,
      candidate_generation: row.candidate_generation,
      evaluation_count: row.evaluation_count,
      first_evaluated_at: row.first_evaluated_at,
      last_evaluated_at: row.last_evaluated_at,
      latest_status: row.latest_status,
      latest_evaluation_source: row.latest_evaluation_source ?? null,
      latest_acceptance_decision: row.latest_acceptance_decision,
      artifact_path: row.artifact_path,
      summary,
    };
  } catch {
    return null;
  }
}

function compareMetric(current: number | null | undefined, baseline: number | null | undefined) {
  if (current == null || baseline == null) {
    return {
      delta: null,
      improved: false,
      regressed: false,
    } satisfies MetricComparison;
  }
  const delta = current - baseline;
  return {
    delta,
    improved: delta > METRIC_EPSILON,
    regressed: delta < -METRIC_EPSILON,
  } satisfies MetricComparison;
}

function compareBodyMetric(
  current: CreatePackageBodySummary | undefined,
  baseline: CreatePackageBodySummary | undefined,
): MetricComparison {
  if (!current || !baseline) {
    return {
      delta: null,
      improved: false,
      regressed: false,
    };
  }
  if (current.valid !== baseline.valid) {
    const delta = current.valid ? 1 : -1;
    return {
      delta,
      improved: delta > 0,
      regressed: delta < 0,
    };
  }
  return compareMetric(current.quality_score, baseline.quality_score);
}

function formatDelta(delta: number, percent: boolean = true): string {
  if (percent) return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`;
}

function compareOptionalNumbersDesc(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return right - left;
}

function compareOptionalNumbersAsc(
  left: number | null | undefined,
  right: number | null | undefined,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return left - right;
}

function acceptedFrontierWatchRank(summary: CreatePackageEvaluationSummary): number {
  const watch = summary.watch;
  if (!watch) return 1;
  if (
    watch.rolled_back ||
    watch.alert != null ||
    watch.grade_regression != null ||
    watch.efficiency_regression != null
  ) {
    return 0;
  }
  return 2;
}

function acceptedFrontierGradingRank(summary: CreatePackageEvaluationSummary): number {
  const grading = summary.grading;
  if (!grading) return 1;
  if (grading.regressed === true) return 0;
  if (grading.regressed === false) return 2;
  return 1;
}

function acceptedFrontierBodyRank(summary: CreatePackageEvaluationSummary): number {
  return summary.body?.valid ? 1 : 0;
}

function compareAcceptedFrontierCandidates(
  left: CreatePackageCandidateRecord,
  right: CreatePackageCandidateRecord,
): number {
  const comparisons = [
    compareOptionalNumbersDesc(
      acceptedFrontierWatchRank(left.summary),
      acceptedFrontierWatchRank(right.summary),
    ),
    compareOptionalNumbersDesc(
      acceptedFrontierGradingRank(left.summary),
      acceptedFrontierGradingRank(right.summary),
    ),
    compareOptionalNumbersDesc(
      left.summary.grading?.pass_rate_delta,
      right.summary.grading?.pass_rate_delta,
    ),
    compareOptionalNumbersDesc(
      left.summary.grading?.recent?.average_pass_rate,
      right.summary.grading?.recent?.average_pass_rate,
    ),
    compareOptionalNumbersDesc(left.summary.replay.pass_rate, right.summary.replay.pass_rate),
    compareOptionalNumbersDesc(left.summary.routing?.pass_rate, right.summary.routing?.pass_rate),
    compareOptionalNumbersDesc(left.summary.baseline.lift, right.summary.baseline.lift),
    compareOptionalNumbersDesc(
      left.summary.unit_tests?.pass_rate,
      right.summary.unit_tests?.pass_rate,
    ),
    compareOptionalNumbersDesc(
      acceptedFrontierBodyRank(left.summary),
      acceptedFrontierBodyRank(right.summary),
    ),
    compareOptionalNumbersDesc(left.summary.body?.quality_score, right.summary.body?.quality_score),
    compareOptionalNumbersAsc(
      left.summary.efficiency?.with_skill.avg_duration_ms,
      right.summary.efficiency?.with_skill.avg_duration_ms,
    ),
    compareOptionalNumbersAsc(
      left.summary.efficiency?.with_skill.total_cost_usd,
      right.summary.efficiency?.with_skill.total_cost_usd,
    ),
    compareOptionalNumbersAsc(
      left.summary.efficiency?.with_skill.total_turns,
      right.summary.efficiency?.with_skill.total_turns,
    ),
    compareOptionalNumbersDesc(left.candidate_generation, right.candidate_generation),
    right.last_evaluated_at.localeCompare(left.last_evaluated_at),
  ];

  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}

function buildCandidateAcceptanceSummary(
  summary: CreatePackageEvaluationSummary,
  parentCandidateId: string | null,
  parent: CreatePackageCandidateRecord | null,
  decidedAt: string,
): CreatePackageCandidateAcceptanceSummary {
  if (!parentCandidateId) {
    return {
      decision: "root",
      compared_to_candidate_id: null,
      decided_at: decidedAt,
      rationale: "Initial measured package candidate for this skill.",
      replay_pass_rate_delta: null,
      routing_pass_rate_delta: null,
      baseline_lift_delta: null,
      body_quality_delta: null,
      unit_test_pass_rate_delta: null,
    };
  }

  if (!parent) {
    return {
      decision: "rejected",
      compared_to_candidate_id: parentCandidateId,
      decided_at: decidedAt,
      rationale:
        "Parent candidate evidence is unavailable, so measured acceptance could not be determined.",
      replay_pass_rate_delta: null,
      routing_pass_rate_delta: null,
      baseline_lift_delta: null,
      body_quality_delta: null,
      unit_test_pass_rate_delta: null,
    };
  }

  const replay = compareMetric(summary.replay.pass_rate, parent.summary.replay.pass_rate);
  const routing = compareMetric(summary.routing?.pass_rate, parent.summary.routing?.pass_rate);
  const baselineLift = compareMetric(summary.baseline.lift, parent.summary.baseline.lift);
  const bodyQuality = compareBodyMetric(summary.body, parent.summary.body);
  const unitTests = compareMetric(
    summary.unit_tests?.pass_rate,
    parent.summary.unit_tests?.pass_rate,
  );

  const regressions: string[] = [];
  const improvements: string[] = [];
  const addDeltaSummary = (
    label: string,
    comparison: MetricComparison,
    options: { percent?: boolean } = {},
  ) => {
    if (comparison.regressed && comparison.delta != null) {
      regressions.push(`${label} ${formatDelta(comparison.delta, options.percent ?? true)}`);
    } else if (comparison.improved && comparison.delta != null) {
      improvements.push(`${label} ${formatDelta(comparison.delta, options.percent ?? true)}`);
    }
  };

  addDeltaSummary("replay", replay);
  addDeltaSummary("routing", routing);
  addDeltaSummary("baseline lift", baselineLift, { percent: false });
  addDeltaSummary("body quality", bodyQuality, { percent: false });
  addDeltaSummary("unit tests", unitTests);

  let decision: CreatePackageCandidateAcceptanceDecision;
  let rationale: string;
  if (regressions.length > 0) {
    decision = "rejected";
    rationale = `Measured regressions vs parent: ${regressions.join(", ")}.`;
  } else if (improvements.length > 0) {
    decision = "accepted";
    rationale = `Measured improvement vs parent: ${improvements.join(", ")}.`;
  } else {
    decision = "rejected";
    rationale = "No measured improvement over the parent candidate.";
  }

  return {
    decision,
    compared_to_candidate_id: parent.candidate_id,
    decided_at: decidedAt,
    rationale,
    replay_pass_rate_delta: replay.delta,
    routing_pass_rate_delta: routing.delta,
    baseline_lift_delta: baselineLift.delta,
    body_quality_delta: bodyQuality.delta,
    unit_test_pass_rate_delta: unitTests.delta,
  };
}

function upsertCandidateRecord(db: Database, record: CreatePackageCandidateRecord): void {
  db.run(
    `INSERT INTO package_candidates (
       candidate_id,
       skill_name,
       skill_path,
       package_fingerprint,
       parent_candidate_id,
       candidate_generation,
       evaluation_count,
       first_evaluated_at,
       last_evaluated_at,
       latest_status,
       latest_evaluation_source,
       latest_acceptance_decision,
       artifact_path,
       summary_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(candidate_id) DO UPDATE SET
       skill_path = excluded.skill_path,
       parent_candidate_id = excluded.parent_candidate_id,
       candidate_generation = excluded.candidate_generation,
       evaluation_count = excluded.evaluation_count,
       last_evaluated_at = excluded.last_evaluated_at,
       latest_status = excluded.latest_status,
       latest_evaluation_source = excluded.latest_evaluation_source,
       latest_acceptance_decision = excluded.latest_acceptance_decision,
       artifact_path = excluded.artifact_path,
       summary_json = excluded.summary_json`,
    [
      record.candidate_id,
      record.skill_name,
      record.skill_path,
      record.package_fingerprint,
      record.parent_candidate_id,
      record.candidate_generation,
      record.evaluation_count,
      record.first_evaluated_at,
      record.last_evaluated_at,
      record.latest_status,
      record.latest_evaluation_source,
      record.latest_acceptance_decision,
      record.artifact_path,
      JSON.stringify(record.summary),
    ],
  );
}

function readExistingCandidate(
  db: Database,
  skillName: string,
  packageFingerprint: string,
): CreatePackageCandidateRecord | null {
  const row = db
    .query<CandidateRow, (string | null)[]>(
      `SELECT
         candidate_id,
         skill_name,
         skill_path,
         package_fingerprint,
         parent_candidate_id,
         candidate_generation,
         evaluation_count,
         first_evaluated_at,
         last_evaluated_at,
         latest_status,
         latest_evaluation_source,
         latest_acceptance_decision,
         artifact_path,
         summary_json
       FROM package_candidates
       WHERE skill_name = ? AND package_fingerprint = ?`,
    )
    .get(skillName, packageFingerprint);

  return row ? hydrateCandidateRow(row) : null;
}

function readCandidateById(db: Database, candidateId: string): CreatePackageCandidateRecord | null {
  const row = db
    .query<CandidateRow, (string | null)[]>(
      `SELECT
         candidate_id,
         skill_name,
         skill_path,
         package_fingerprint,
         parent_candidate_id,
         candidate_generation,
         evaluation_count,
         first_evaluated_at,
         last_evaluated_at,
         latest_status,
         latest_evaluation_source,
         latest_acceptance_decision,
         artifact_path,
         summary_json
       FROM package_candidates
       WHERE candidate_id = ?`,
    )
    .get(candidateId);
  return row ? hydrateCandidateRow(row) : null;
}

function readLatestCandidateForSkill(
  db: Database,
  skillName: string,
): CreatePackageCandidateRecord | null {
  const row = db
    .query<CandidateRow, (string | null)[]>(
      `SELECT
         candidate_id,
         skill_name,
         skill_path,
         package_fingerprint,
         parent_candidate_id,
         candidate_generation,
         evaluation_count,
         first_evaluated_at,
         last_evaluated_at,
         latest_status,
         latest_evaluation_source,
         latest_acceptance_decision,
         artifact_path,
         summary_json
       FROM package_candidates
       WHERE skill_name = ?
       ORDER BY last_evaluated_at DESC, candidate_generation DESC
       LIMIT 1`,
    )
    .get(skillName);
  return row ? hydrateCandidateRow(row) : null;
}

function readAcceptedPackageFrontierCandidatesForSkill(
  db: Database,
  skillName: string,
  excludeCandidateId: string | null = null,
): CreatePackageCandidateRecord[] {
  const rows = db
    .query<CandidateRow, (string | null)[]>(
      `SELECT
         candidate_id,
         skill_name,
         skill_path,
         package_fingerprint,
         parent_candidate_id,
         candidate_generation,
         evaluation_count,
         first_evaluated_at,
         last_evaluated_at,
         latest_status,
         latest_evaluation_source,
         latest_acceptance_decision,
         artifact_path,
         summary_json
       FROM package_candidates
       WHERE skill_name = ?
         AND latest_acceptance_decision IN ('root', 'accepted')
         AND (? IS NULL OR candidate_id != ?)
       ORDER BY candidate_generation ASC, first_evaluated_at ASC`,
    )
    .all(skillName, excludeCandidateId, excludeCandidateId);
  return rows
    .flatMap((row) => {
      const hydrated = hydrateCandidateRow(row);
      return hydrated ? [hydrated] : [];
    })
    .toSorted(compareAcceptedFrontierCandidates);
}

export function listPackageCandidates(
  skillName: string,
  db: Database | null = getOptionalDb(),
): CreatePackageCandidateRecord[] {
  if (!db) return [];
  const rows = db
    .query<CandidateRow, (string | null)[]>(
      `SELECT
         candidate_id,
         skill_name,
         skill_path,
         package_fingerprint,
         parent_candidate_id,
         candidate_generation,
         evaluation_count,
         first_evaluated_at,
         last_evaluated_at,
         latest_status,
         latest_evaluation_source,
         latest_acceptance_decision,
         artifact_path,
         summary_json
       FROM package_candidates
       WHERE skill_name = ?
       ORDER BY candidate_generation ASC, first_evaluated_at ASC`,
    )
    .all(skillName);

  return rows.flatMap((row) => {
    const hydrated = hydrateCandidateRow(row);
    return hydrated ? [hydrated] : [];
  });
}

export function listAcceptedPackageCandidates(
  skillName: string,
  db: Database | null = getOptionalDb(),
): CreatePackageCandidateRecord[] {
  return listPackageCandidates(skillName, db).filter(
    (candidate) =>
      candidate.latest_acceptance_decision === "root" ||
      candidate.latest_acceptance_decision === "accepted",
  );
}

export function listAcceptedPackageFrontierCandidates(
  skillName: string,
  db: Database | null = getOptionalDb(),
): CreatePackageCandidateRecord[] {
  if (!db) return [];
  return readAcceptedPackageFrontierCandidatesForSkill(db, skillName);
}

export function selectAcceptedPackageFrontierCandidate(
  skillName: string,
  options: {
    excludeCandidateId?: string | null;
    db?: Database | null;
  } = {},
): CreatePackageCandidateRecord | null {
  const db = options.db ?? getOptionalDb();
  if (!db) return null;
  return (
    readAcceptedPackageFrontierCandidatesForSkill(
      db,
      skillName,
      options.excludeCandidateId ?? null,
    )[0] ?? null
  );
}

export function readPackageCandidateArtifactByFingerprint(
  skillName: string,
  packageFingerprint: string,
  options: {
    acceptedOnly?: boolean;
    db?: Database | null;
  } = {},
): CreatePackageEvaluationResult | null {
  const db = options.db ?? getOptionalDb();
  if (!db) return null;

  const candidate = readExistingCandidate(db, skillName, packageFingerprint);
  if (!candidate) return null;
  if (
    options.acceptedOnly &&
    candidate.latest_acceptance_decision !== "root" &&
    candidate.latest_acceptance_decision !== "accepted"
  ) {
    return null;
  }

  return readCandidateArtifactForRecord(candidate);
}

export function persistPackageCandidateEvaluation(
  evaluation: CreatePackageEvaluationResult,
  db: Database | null = getOptionalDb(),
): CreatePackageEvaluationResult {
  const packageFingerprint = evaluation.summary.package_fingerprint;
  if (!packageFingerprint) return evaluation;

  const now = new Date().toISOString();
  const existing = db
    ? readExistingCandidate(db, evaluation.summary.skill_name, packageFingerprint)
    : null;
  const latestForSkill = db ? readLatestCandidateForSkill(db, evaluation.summary.skill_name) : null;
  const parent = existing ? existing.parent_candidate_id : (latestForSkill?.candidate_id ?? null);
  const candidateGeneration =
    existing?.candidate_generation ?? (latestForSkill?.candidate_generation ?? -1) + 1;
  const candidateId =
    existing?.candidate_id ?? buildCandidateId(evaluation.summary.skill_name, packageFingerprint);
  const comparisonCandidateId =
    existing?.summary.candidate_acceptance?.compared_to_candidate_id ??
    (db
      ? (selectAcceptedPackageFrontierCandidate(evaluation.summary.skill_name, {
          excludeCandidateId: existing?.candidate_id ?? null,
          db,
        })?.candidate_id ?? parent)
      : parent);
  const comparisonCandidate =
    db && comparisonCandidateId ? readCandidateById(db, comparisonCandidateId) : null;

  const summaryWithCandidate: CreatePackageEvaluationSummary = {
    ...evaluation.summary,
    candidate_id: candidateId,
    parent_candidate_id: parent,
    candidate_generation: candidateGeneration,
  };
  const acceptance = buildCandidateAcceptanceSummary(
    summaryWithCandidate,
    comparisonCandidateId,
    comparisonCandidate,
    now,
  );

  const summary: CreatePackageEvaluationSummary = {
    ...summaryWithCandidate,
    candidate_acceptance: acceptance,
  };
  const enrichedEvaluation: CreatePackageEvaluationResult = {
    ...evaluation,
    summary,
  };

  const artifactPath = getPackageCandidateArtifactPath(evaluation.summary.skill_name, candidateId);
  mkdirSync(join(getPackageCandidateRoot(), sanitizeSkillName(evaluation.summary.skill_name)), {
    recursive: true,
  });
  writeFileSync(artifactPath, JSON.stringify(enrichedEvaluation, null, 2), "utf-8");

  if (db) {
    const record: CreatePackageCandidateRecord = {
      candidate_id: candidateId,
      skill_name: evaluation.summary.skill_name,
      skill_path: evaluation.summary.skill_path,
      package_fingerprint: packageFingerprint,
      parent_candidate_id: parent,
      candidate_generation: candidateGeneration,
      evaluation_count: (existing?.evaluation_count ?? 0) + 1,
      first_evaluated_at: existing?.first_evaluated_at ?? now,
      last_evaluated_at: now,
      latest_status: summary.status,
      latest_evaluation_source: summary.evaluation_source ?? null,
      latest_acceptance_decision: summary.candidate_acceptance?.decision ?? null,
      artifact_path: artifactPath,
      summary,
    };
    upsertCandidateRecord(db, record);
  }

  return enrichedEvaluation;
}

export function refreshPackageCandidateEvaluationObservation(
  evaluation: CreatePackageEvaluationResult,
  db: Database | null = getOptionalDb(),
): CreatePackageEvaluationResult {
  const candidateId = evaluation.summary.candidate_id;
  const packageFingerprint = evaluation.summary.package_fingerprint;
  if (!candidateId && !packageFingerprint) return evaluation;

  const existing =
    db && candidateId
      ? readCandidateById(db, candidateId)
      : db && packageFingerprint
        ? readExistingCandidate(db, evaluation.summary.skill_name, packageFingerprint)
        : null;
  if (!existing) return evaluation;

  const artifactPath =
    existing.artifact_path ??
    getPackageCandidateArtifactPath(existing.skill_name, existing.candidate_id);
  mkdirSync(join(getPackageCandidateRoot(), sanitizeSkillName(existing.skill_name)), {
    recursive: true,
  });
  writeFileSync(artifactPath, JSON.stringify(evaluation, null, 2), "utf-8");

  if (db) {
    const record: CreatePackageCandidateRecord = {
      ...existing,
      latest_status: evaluation.summary.status,
      latest_evaluation_source:
        evaluation.summary.evaluation_source ?? existing.latest_evaluation_source,
      latest_acceptance_decision:
        evaluation.summary.candidate_acceptance?.decision ?? existing.latest_acceptance_decision,
      artifact_path: artifactPath,
      summary: evaluation.summary,
    };
    upsertCandidateRecord(db, record);
  }

  return evaluation;
}

export function readPackageCandidateArtifact(
  skillName: string,
  candidateId: string,
): CreatePackageEvaluationResult | null {
  return readCandidateArtifact(getPackageCandidateArtifactPath(skillName, candidateId));
}
