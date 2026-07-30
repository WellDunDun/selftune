import type { Database } from "bun:sqlite";

const MAX_JSON_BYTES = 65_536;
const MAX_DISPLAY_TEXT = 8_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parseRecord(value: unknown): JsonRecord {
  if (typeof value !== "string" || value.length > MAX_JSON_BYTES) return {};
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function text(value: unknown, fallback = ""): string {
  return (typeof value === "string" ? value : fallback).slice(0, MAX_DISPLAY_TEXT);
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

function proposedChange(study: JsonRecord, manifest: JsonRecord) {
  const candidate = record(manifest.candidate);
  const installed = text(candidate?.installed_body);
  const proposed = text(candidate?.proposed_body);
  if (installed && proposed && installed !== proposed) {
    const changedLines =
      typeof candidate?.changed_lines === "number" && Number.isInteger(candidate.changed_lines)
        ? String(candidate.changed_lines)
        : "Bounded";
    return {
      diff: bodyDiff(installed, proposed),
      summary: `${changedLines} changed line(s)`,
    };
  }

  const revisions = record(study.revisions);
  const before = text(revisions?.pre_edit_revision);
  const after = text(revisions?.post_edit_revision);
  return before && after && before !== after
    ? {
        summary: `Human edit captured at exact revisions ${before.slice(0, 12)} → ${after.slice(0, 12)}`,
      }
    : null;
}

function regressionFailures(manifest: JsonRecord, result: JsonRecord): string[] {
  const activeIds = new Set(
    (Array.isArray(manifest.active_regression_cases) ? manifest.active_regression_cases : [])
      .map(record)
      .filter((entry): entry is JsonRecord => entry !== null)
      .map((entry) => text(entry.case_id))
      .filter(Boolean),
  );
  return (Array.isArray(result.trials) ? result.trials : [])
    .map(record)
    .filter((entry): entry is JsonRecord => entry !== null)
    .filter(
      (entry) =>
        entry.arm === "candidate_skill" &&
        activeIds.has(text(entry.case_id)) &&
        (entry.skipped === true ||
          (typeof entry.passed_repetitions === "number" &&
            typeof entry.scored_repetitions === "number" &&
            entry.passed_repetitions < entry.scored_repetitions)),
    )
    .map((entry) => text(entry.case_id));
}

function verifierProvenance(value: unknown): string {
  const verifier = parseRecord(value);
  const instrument = record(verifier.instrument);
  const id = text(instrument?.verifier_id);
  const version = text(instrument?.version);
  return id ? `Verifier ${id}${version ? `@${version}` : ""}` : "Candidate manifest";
}

export function projectCorrectionReview(row: Record<string, unknown>) {
  const signal = parseRecord(row.signal_payload_json);
  const study = parseRecord(row.study_payload_json);
  const capsule = record(study.task_capsule) ?? {};
  const manifest = parseRecord(row.evaluation_manifest_json);
  const result = parseRecord(row.evaluation_result_json);
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
      capsule.observed_failure,
      text(signal.reason, text(row.reason, "Observed correction")),
    ),
    correction_intent: text(capsule.correction_intent, text(signal.correction_intent)),
    proposed_change: proposedChange(study, manifest),
    evaluation: evaluationStatus
      ? {
          summary: `${evaluationStatus}: ${text(
            result.reason,
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
    .query(
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
    .all(limit) as Record<string, unknown>[];
  return rows.map(projectCorrectionReview);
}
