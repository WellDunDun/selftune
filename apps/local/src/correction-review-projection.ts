import type { Database } from "bun:sqlite";
import { Effect, Option, Schema } from "effect";
import { optionalEvidence } from "@selftune/runtime/utils/transcript-contract";

const MAX_JSON_BYTES = 65_536;
const MAX_DISPLAY_TEXT = 8_000;

const TextEvidence = optionalEvidence(Schema.String);
const Signal = Schema.Struct({ reason: TextEvidence, correction_intent: TextEvidence });
const Study = Schema.Struct({
  task_capsule: optionalEvidence(
    Schema.Struct({
      observed_failure: TextEvidence,
      correction_intent: TextEvidence,
    }),
  ),
  revisions: optionalEvidence(
    Schema.Struct({
      pre_edit_revision: TextEvidence,
      post_edit_revision: TextEvidence,
    }),
  ),
});
const RegressionCase = Schema.Struct({ case_id: TextEvidence }).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some({}))),
);
const Manifest = Schema.Struct({
  candidate: optionalEvidence(
    Schema.Struct({
      installed_body: TextEvidence,
      proposed_body: TextEvidence,
      changed_lines: optionalEvidence(Schema.Number.check(Schema.isInt())),
    }),
  ),
  active_regression_cases: optionalEvidence(Schema.Array(RegressionCase)),
});
const Trial = Schema.Struct({
  case_id: TextEvidence,
  arm: TextEvidence,
  skipped: optionalEvidence(Schema.Boolean),
  passed_repetitions: optionalEvidence(Schema.Number),
  scored_repetitions: optionalEvidence(Schema.Number),
}).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some({}))));
const EvaluationResult = Schema.Struct({
  reason: TextEvidence,
  trials: optionalEvidence(Schema.Array(Trial)),
});
const Verifier = Schema.Struct({
  instrument: optionalEvidence(Schema.Struct({ verifier_id: TextEvidence, version: TextEvidence })),
});

interface CorrectionReviewRow {
  candidate_id?: string | null;
  evidence_level?: string | null;
  reason?: string | null;
  manifest_digest?: string | null;
  signal_payload_json?: string | null;
  study_payload_json?: string | null;
  evaluation_evidence_level?: string | null;
  evaluation_status?: string | null;
  evaluation_reason?: string | null;
  evaluation_manifest_json?: string | null;
  evaluation_result_json?: string | null;
  verifier_provenance?: string | null;
  last_action?: string | null;
}

function parseSaved<A>(schema: Schema.Codec<A>, value: string | null | undefined): A | null {
  if (value == null || value.length > MAX_JSON_BYTES) return null;
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(value);
  } catch {
    return null;
  }
}

function text(value: string | null | undefined, fallback = ""): string {
  return (value ?? fallback).slice(0, MAX_DISPLAY_TEXT);
}

function bodyDiff(before: string, after: string): string {
  const left = before.split("\n");
  const right = after.split("\n");
  const lines = ["--- current skill body", "+++ proposed skill body"];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) lines.push(`-${left[index]}`);
    if (right[index] !== undefined) lines.push(`+${right[index]}`);
  }
  return lines.join("\n").slice(0, MAX_DISPLAY_TEXT);
}

function proposedChange(study: typeof Study.Type | null, manifest: typeof Manifest.Type | null) {
  const candidate = manifest?.candidate;
  const installed = text(candidate?.installed_body);
  const proposed = text(candidate?.proposed_body);
  if (installed && proposed && installed !== proposed) {
    const changedLines =
      candidate?.changed_lines !== undefined ? String(candidate.changed_lines) : "Bounded";
    return {
      diff: bodyDiff(installed, proposed),
      summary: `${changedLines} changed line(s)`,
    };
  }

  const revisions = study?.revisions;
  const before = text(revisions?.pre_edit_revision);
  const after = text(revisions?.post_edit_revision);
  return before && after && before !== after
    ? {
        summary: `Human edit captured at exact revisions ${before.slice(0, 12)} → ${after.slice(0, 12)}`,
      }
    : null;
}

function regressionFailures(
  manifest: typeof Manifest.Type | null,
  result: typeof EvaluationResult.Type | null,
): string[] {
  const activeIds = new Set(
    (manifest?.active_regression_cases ?? []).map((entry) => text(entry.case_id)).filter(Boolean),
  );
  return (result?.trials ?? [])
    .filter(
      (entry) =>
        entry.arm === "candidate_skill" &&
        activeIds.has(text(entry.case_id)) &&
        (entry.skipped === true ||
          (entry.passed_repetitions !== undefined &&
            entry.scored_repetitions !== undefined &&
            entry.passed_repetitions < entry.scored_repetitions)),
    )
    .map((entry) => text(entry.case_id));
}

function verifierProvenance(value: string | null | undefined): string {
  const instrument = parseSaved(Verifier, value)?.instrument;
  const id = text(instrument?.verifier_id);
  const version = text(instrument?.version);
  return id ? `Verifier ${id}${version ? `@${version}` : ""}` : "Candidate manifest";
}

export function projectCorrectionReview(row: CorrectionReviewRow) {
  const signal = parseSaved(Signal, row.signal_payload_json);
  const study = parseSaved(Study, row.study_payload_json);
  const capsule = study?.task_capsule;
  const manifest = parseSaved(Manifest, row.evaluation_manifest_json);
  const result = parseSaved(EvaluationResult, row.evaluation_result_json);
  const evaluationStatus = text(row.evaluation_status);
  const evaluationEvidence = text(row.evaluation_evidence_level);
  const candidateEvidence = text(row.evidence_level);
  const evidenceLevel = ["E0", "E0.5", "E1", "E2"].includes(evaluationEvidence)
    ? evaluationEvidence
    : ["E0", "E0.5", "E1", "E2"].includes(candidateEvidence)
      ? candidateEvidence
      : "E0";
  const lastAction = text(row.last_action);

  return {
    candidate_id: text(row.candidate_id),
    evidence_level: evidenceLevel,
    observed_failure: text(
      capsule?.observed_failure,
      text(signal?.reason, text(row.reason, "Observed correction")),
    ),
    correction_intent: text(capsule?.correction_intent, text(signal?.correction_intent)),
    proposed_change: proposedChange(study, manifest),
    evaluation: evaluationStatus
      ? {
          summary: `${evaluationStatus}: ${text(
            result?.reason,
            text(row.evaluation_reason, "No reason recorded"),
          )}`,
          regressions: regressionFailures(manifest, result),
        }
      : null,
    limitations: [
      "The candidate remains review-only; this decision does not apply a skill.",
      ...(evaluationStatus ? [] : ["No managed replay or blind evaluation is available yet."]),
    ],
    manifest_digest: text(row.manifest_digest),
    provenance: [verifierProvenance(row.verifier_provenance)],
    terminal: lastAction === "accept" || lastAction === "reject",
  };
}

/** One bounded row per candidate, with deterministic latest evidence and decision selection. */
export function listCorrectionReviews(database: Database, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128)
    throw new RangeError("Correction review limit must be between 1 and 128.");
  const rows = database
    .query<CorrectionReviewRow, [number]>(
      `SELECT
        c.candidate_id,
        c.evidence_level,
        c.reason,
        c.manifest_digest,
        c.signal_payload_json,
        (
          SELECT d.study_payload_json
          FROM correction_study_drafts d
          WHERE d.candidate_id = c.candidate_id
          ORDER BY d.updated_at DESC, d.draft_id DESC
          LIMIT 1
        ) AS study_payload_json,
        (
          SELECT e.evidence_level
          FROM correction_candidate_evaluations e
          WHERE e.candidate_id = c.candidate_id
          ORDER BY e.recorded_at DESC, e.evaluation_id DESC
          LIMIT 1
        ) AS evaluation_evidence_level,
        (
          SELECT e.status
          FROM correction_candidate_evaluations e
          WHERE e.candidate_id = c.candidate_id
          ORDER BY e.recorded_at DESC, e.evaluation_id DESC
          LIMIT 1
        ) AS evaluation_status,
        (
          SELECT e.reason
          FROM correction_candidate_evaluations e
          WHERE e.candidate_id = c.candidate_id
          ORDER BY e.recorded_at DESC, e.evaluation_id DESC
          LIMIT 1
        ) AS evaluation_reason,
        (
          SELECT e.blind_manifest_json
          FROM correction_candidate_evaluations e
          WHERE e.candidate_id = c.candidate_id
          ORDER BY e.recorded_at DESC, e.evaluation_id DESC
          LIMIT 1
        ) AS evaluation_manifest_json,
        (
          SELECT e.blind_result_json
          FROM correction_candidate_evaluations e
          WHERE e.candidate_id = c.candidate_id
          ORDER BY e.recorded_at DESC, e.evaluation_id DESC
          LIMIT 1
        ) AS evaluation_result_json,
        (
          SELECT e.verifier_provenance
          FROM correction_candidate_evaluations e
          WHERE e.candidate_id = c.candidate_id
          ORDER BY e.recorded_at DESC, e.evaluation_id DESC
          LIMIT 1
        ) AS verifier_provenance,
        (
          SELECT r.action
          FROM correction_review_decisions r
          WHERE r.candidate_id = c.candidate_id
          ORDER BY r.decided_at DESC, r.decision_id DESC
          LIMIT 1
        ) AS last_action
      FROM correction_signal_candidates c
      ORDER BY c.updated_at DESC, c.candidate_id ASC
      LIMIT ?`,
    )
    .all(limit);
  return rows.map(projectCorrectionReview);
}
