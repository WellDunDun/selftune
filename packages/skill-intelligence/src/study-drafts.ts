import { createHash } from "node:crypto";

import * as Schema from "effect/Schema";

export const STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH = 8_000;
export const STUDY_DRAFT_MAX_EXCERPT_LENGTH = 1_024;

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_000));
const RevisionText = Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)));

export const StudyHypothesisKind = Schema.Literals(["explicit_correction", "missed_opportunity"]);
export const StudyMutationSurface = Schema.Literals([
  "description",
  "routing",
  "body",
  "frontmatter",
  "executable",
  "cross_file",
  "unsupported",
]);
export const StudyPrivacyInputDisposition = Schema.Literals([
  "safe",
  "redacted",
  "secret_unredactable",
]);
export const StudyEvidencePartition = Schema.Literals(["calibration", "selection", "audit"]);

export const StudyDraftHypothesis = Schema.Struct({
  hypothesis_id: Identifier,
  kind: StudyHypothesisKind,
  skill_ids: Schema.Array(Identifier).check(Schema.isMaxLength(8)),
  task: BoundedText,
  observed_failure: BoundedText,
  correction_intent: Schema.NullOr(BoundedText),
  pre_edit_revision: RevisionText,
  post_edit_revision: RevisionText,
  current_revision: RevisionText,
  mutation_surface: StudyMutationSurface,
  ambiguous: Schema.Boolean,
  privacy_disposition: StudyPrivacyInputDisposition,
});
export type StudyDraftHypothesis = typeof StudyDraftHypothesis.Type;

export const StudyCalibrationEvidence = Schema.Struct({
  evidence_id: Identifier,
  source_reference: BoundedText,
  summary: BoundedText,
  excerpt: BoundedText,
});
export type StudyCalibrationEvidence = typeof StudyCalibrationEvidence.Type;

/** Selection and audit references intentionally have no task text or excerpt. */
export const StudyHiddenEvidenceReference = Schema.Struct({
  evidence_id: Identifier,
  partition: Schema.Literals(["selection", "audit"]),
  source_reference: BoundedText,
  content_fingerprint: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
});
export type StudyHiddenEvidenceReference = typeof StudyHiddenEvidenceReference.Type;

export const StudyDraftBuildInput = Schema.Struct({
  hypothesis: StudyDraftHypothesis,
  calibration_evidence: Schema.Array(StudyCalibrationEvidence).check(Schema.isMaxLength(14)),
  hidden_references: Schema.Array(StudyHiddenEvidenceReference).check(Schema.isMaxLength(64)),
});
export type StudyDraftBuildInput = typeof StudyDraftBuildInput.Type;

export const StudyDraftDisposition = Schema.Literals(["ready_for_verifier", "deferred"]);
export const StudyRevisionEvidenceStatus = Schema.Literals([
  "exact_pre_post",
  "exact_current",
  "missing_or_invalid",
]);
export const StudyPrivacyDisposition = Schema.Literals(["safe", "redacted", "secret_unredactable"]);
export const StudyDraftDeferReason = Schema.Literals([
  "ambiguous_hypothesis",
  "multi_skill_hypothesis",
  "unsupported_mutation_surface",
  "secret_unredactable",
  "invalid_revision_evidence",
  "missing_calibration_evidence",
]);

export const StudyTaskCapsule = Schema.Struct({
  task: Schema.String.check(Schema.isMaxLength(STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH)),
  observed_failure: Schema.String.check(Schema.isMaxLength(STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH)),
  correction_intent: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH)),
  ),
  calibration_evidence: Schema.Array(
    Schema.Struct({
      evidence_id: Identifier,
      source_reference: Schema.String.check(Schema.isMaxLength(STUDY_DRAFT_MAX_EXCERPT_LENGTH)),
      summary: Schema.String.check(Schema.isMaxLength(STUDY_DRAFT_MAX_EXCERPT_LENGTH)),
      excerpt: Schema.String.check(Schema.isMaxLength(STUDY_DRAFT_MAX_EXCERPT_LENGTH)),
    }),
  ),
});

export const StudyDraft = Schema.Struct({
  draft_id: Identifier,
  manifest_id: Identifier,
  hypothesis_kind: StudyHypothesisKind,
  disposition: StudyDraftDisposition,
  defer_reasons: Schema.Array(StudyDraftDeferReason),
  task_capsule: StudyTaskCapsule,
  success_contract: Schema.String.check(Schema.isMaxLength(STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH)),
  mutation_surface: StudyMutationSurface,
  privacy_disposition: StudyPrivacyDisposition,
  revision_evidence_status: StudyRevisionEvidenceStatus,
  revisions: Schema.Struct({
    pre_edit_revision: RevisionText,
    post_edit_revision: RevisionText,
    current_revision: RevisionText,
  }),
  hidden_references: Schema.Array(StudyHiddenEvidenceReference),
  verifier_qualification: Schema.Literal("not_attempted"),
  replay_status: Schema.Literal("not_attempted"),
});
export type StudyDraft = typeof StudyDraft.Type;

function boundedRedactedText(value: string, maximumLength: number): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted-private-key]",
    )
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]")
    .slice(0, maximumLength);
}

function exactRevision(value: string | null): boolean {
  return value !== null && /^[a-f0-9]{64}$/.test(value);
}

function revisionEvidenceStatus(
  hypothesis: StudyDraftHypothesis,
): typeof StudyRevisionEvidenceStatus.Type {
  if (
    hypothesis.kind === "explicit_correction" &&
    exactRevision(hypothesis.pre_edit_revision) &&
    exactRevision(hypothesis.post_edit_revision) &&
    hypothesis.pre_edit_revision !== hypothesis.post_edit_revision
  ) {
    return "exact_pre_post";
  }
  if (hypothesis.kind === "missed_opportunity" && exactRevision(hypothesis.current_revision)) {
    return "exact_current";
  }
  return "missing_or_invalid";
}

function deferReasons(input: StudyDraftBuildInput): Array<typeof StudyDraftDeferReason.Type> {
  const reasons: Array<typeof StudyDraftDeferReason.Type> = [];
  if (input.hypothesis.ambiguous) reasons.push("ambiguous_hypothesis");
  if (new Set(input.hypothesis.skill_ids).size !== 1) reasons.push("multi_skill_hypothesis");
  if (
    input.hypothesis.mutation_surface === "frontmatter" ||
    input.hypothesis.mutation_surface === "executable" ||
    input.hypothesis.mutation_surface === "cross_file" ||
    input.hypothesis.mutation_surface === "unsupported"
  ) {
    reasons.push("unsupported_mutation_surface");
  }
  if (input.hypothesis.privacy_disposition === "secret_unredactable") {
    reasons.push("secret_unredactable");
  }
  if (revisionEvidenceStatus(input.hypothesis) === "missing_or_invalid") {
    reasons.push("invalid_revision_evidence");
  }
  if (input.calibration_evidence.length === 0) reasons.push("missing_calibration_evidence");
  return reasons;
}

function canonicalManifest(input: StudyDraftBuildInput): string {
  return JSON.stringify({
    hypothesis: {
      ...input.hypothesis,
      task: boundedRedactedText(input.hypothesis.task, STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH),
      observed_failure: boundedRedactedText(
        input.hypothesis.observed_failure,
        STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH,
      ),
      correction_intent:
        input.hypothesis.correction_intent === null
          ? null
          : boundedRedactedText(
              input.hypothesis.correction_intent,
              STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH,
            ),
    },
    calibration_evidence: input.calibration_evidence
      .map((entry) => ({
        evidence_id: entry.evidence_id,
        source_reference: boundedRedactedText(
          entry.source_reference,
          STUDY_DRAFT_MAX_EXCERPT_LENGTH,
        ),
        summary: boundedRedactedText(entry.summary, STUDY_DRAFT_MAX_EXCERPT_LENGTH),
        excerpt: boundedRedactedText(entry.excerpt, STUDY_DRAFT_MAX_EXCERPT_LENGTH),
      }))
      .toSorted((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
    hidden_references: input.hidden_references
      .map((entry) => ({
        evidence_id: entry.evidence_id,
        partition: entry.partition,
        source_reference: boundedRedactedText(
          entry.source_reference,
          STUDY_DRAFT_MAX_EXCERPT_LENGTH,
        ),
        content_fingerprint: entry.content_fingerprint,
      }))
      .toSorted((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
  });
}

function stableId(prefix: string, canonical: string): string {
  return `${prefix}-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/**
 * Builds only the bounded, redacted study hand-off. Verifier qualification and
 * replay are deliberately separate stages and are never inferred here.
 */
export function buildStudyDraft(input: StudyDraftBuildInput): StudyDraft {
  const manifest = canonicalManifest(input);
  const manifestId = stableId("study-manifest", manifest);
  const reasons = deferReasons(input);
  const privacy = input.hypothesis.privacy_disposition;
  const capsule = {
    task: boundedRedactedText(input.hypothesis.task, STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH),
    observed_failure: boundedRedactedText(
      input.hypothesis.observed_failure,
      STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH,
    ),
    correction_intent:
      input.hypothesis.correction_intent === null
        ? null
        : boundedRedactedText(
            input.hypothesis.correction_intent,
            STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH,
          ),
    calibration_evidence: input.calibration_evidence.map((entry) => ({
      evidence_id: entry.evidence_id,
      source_reference: boundedRedactedText(entry.source_reference, STUDY_DRAFT_MAX_EXCERPT_LENGTH),
      summary: boundedRedactedText(entry.summary, STUDY_DRAFT_MAX_EXCERPT_LENGTH),
      excerpt: boundedRedactedText(entry.excerpt, STUDY_DRAFT_MAX_EXCERPT_LENGTH),
    })),
  };
  const successContract = boundedRedactedText(
    input.hypothesis.kind === "explicit_correction"
      ? (input.hypothesis.correction_intent ?? input.hypothesis.observed_failure)
      : `Avoid the observed failure: ${input.hypothesis.observed_failure}`,
    STUDY_DRAFT_MAX_CAPSULE_TEXT_LENGTH,
  );
  return StudyDraft.make({
    draft_id: stableId("study-draft", manifest),
    manifest_id: manifestId,
    hypothesis_kind: input.hypothesis.kind,
    disposition: reasons.length === 0 ? "ready_for_verifier" : "deferred",
    defer_reasons: reasons,
    task_capsule: capsule,
    success_contract: successContract,
    mutation_surface: input.hypothesis.mutation_surface,
    privacy_disposition: privacy,
    revision_evidence_status: revisionEvidenceStatus(input.hypothesis),
    revisions: {
      pre_edit_revision: input.hypothesis.pre_edit_revision,
      post_edit_revision: input.hypothesis.post_edit_revision,
      current_revision: input.hypothesis.current_revision,
    },
    hidden_references: input.hidden_references.map((entry) => ({
      ...entry,
      source_reference: boundedRedactedText(entry.source_reference, STUDY_DRAFT_MAX_EXCERPT_LENGTH),
    })),
    verifier_qualification: "not_attempted",
    replay_status: "not_attempted",
  });
}
