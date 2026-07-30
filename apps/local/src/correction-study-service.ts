import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import {
  CorrectionEvidenceLedgerEntry,
  CorrectionEpisode as PersistedCorrectionEpisode,
  type CorrectionStudy as PersistedCorrectionStudy,
  CorrectionStudyPersistenceConflict,
  PromotedStudyCase,
  createOrGetCorrectionStudy,
  getCorrectionStudy,
} from "@selftune/local-store";
import {
  evaluateCorrectionStudy,
  type CorrectionEpisode,
  type PairedReplayTrial,
  type VerifierInstrument,
} from "@selftune/skill-intelligence/correction-studies";
import {
  type PairedReplayArmExecutor,
  PairedReplayRuntime,
  PairedReplayTaskCase,
  runManagedPairedReplay,
} from "@selftune/skill-intelligence/paired-replay";
import { VerifierQualificationResult } from "@selftune/skill-intelligence/verifier-instruments";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_000));
const ProvenanceText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const SkillPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Timestamp = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);
const MinimumScoredTrials = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(3),
  Schema.isLessThanOrEqualTo(32),
);

class CorrectionEpisodeProvenanceRequest extends Schema.Class<CorrectionEpisodeProvenanceRequest>(
  "CorrectionEpisodeProvenanceRequest",
)({
  harness: Identifier,
  trace_id: ProvenanceText,
  session_id: ProvenanceText,
}) {}

class ExplicitCorrectionEpisodeRequest extends Schema.Class<ExplicitCorrectionEpisodeRequest>(
  "ExplicitCorrectionEpisodeRequest",
)({
  skill_id: Identifier,
  skill_name: Identifier,
  skill_path: SkillPath,
  task: BoundedText,
  observed_failure: BoundedText,
  correction_intent: BoundedText,
  pre_edit_revision: Revision,
  post_edit_revision: Revision,
  bounded_diff: BoundedText,
  provenance: CorrectionEpisodeProvenanceRequest,
  captured_at: Timestamp,
}) {}

class VerifierQualificationRequest extends Schema.Class<VerifierQualificationRequest>(
  "VerifierQualificationRequest",
)({
  rejects_known_failure: Schema.Boolean,
  accepts_known_good: Schema.Boolean,
}) {}

class VerifierInstrumentRequest extends Schema.Class<VerifierInstrumentRequest>(
  "VerifierInstrumentRequest",
)({
  verifier_id: Identifier,
  version: Identifier,
  kind: Schema.Literal("deterministic"),
  qualification: VerifierQualificationRequest,
}) {}

const ReplayTrialOutcome = Schema.Literals(["pass", "fail", "infrastructure_error"]);

class PairedReplayTrialRequest extends Schema.Class<PairedReplayTrialRequest>(
  "PairedReplayTrialRequest",
)({
  pair_id: Identifier,
  pre_edit: ReplayTrialOutcome,
  post_edit: ReplayTrialOutcome,
}) {}

export class ExplicitCorrectionStudyRequest extends Schema.Class<ExplicitCorrectionStudyRequest>(
  "ExplicitCorrectionStudyRequest",
)({
  episode: ExplicitCorrectionEpisodeRequest,
  verifier: VerifierInstrumentRequest,
  trials: Schema.Array(PairedReplayTrialRequest).check(Schema.isMaxLength(64)),
  minimum_scored_trials: Schema.optionalKey(MinimumScoredTrials),
}) {}

/**
 * A frozen correction study request. The replay executor is deliberately not
 * part of this value: only the local coordinator supplies execution.
 */
export class ManagedCorrectionStudyRequest extends Schema.Class<ManagedCorrectionStudyRequest>(
  "ManagedCorrectionStudyRequest",
)({
  episode: ExplicitCorrectionEpisodeRequest,
  task_case: PairedReplayTaskCase,
  current_revision: Revision,
  runtime: PairedReplayRuntime,
  qualified_verifier: VerifierQualificationResult,
  required_scored_repetitions: MinimumScoredTrials,
  max_attempts_per_arm: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(3),
    Schema.isLessThanOrEqualTo(64),
  ),
}) {}

export class CorrectionStudyServiceFailure extends Schema.TaggedErrorClass<CorrectionStudyServiceFailure>()(
  "CorrectionStudyServiceFailure",
  {
    code: Schema.Literals([
      "INVALID_CORRECTION_STUDY_REQUEST",
      "CORRECTION_EPISODE_CONFLICT",
      "CORRECTION_EPISODE_NOT_FOUND",
      "CORRECTION_STUDY_PERSISTENCE_FAILED",
    ]),
    message: Schema.String,
    status: Schema.Number,
  },
) {}

export interface CorrectionStudyServiceResponse {
  readonly episode_id: string;
  readonly skill_id: string;
  readonly skill_name: string;
  readonly evidence_level: "E0.5" | "E1";
  readonly status: "promoted" | "inconclusive" | "invalid";
  readonly reason: string;
  readonly manifest_id: string;
  readonly replay: {
    readonly source: "externally_supplied" | "managed";
    readonly verified_by_selftune: boolean;
    readonly minimum_scored_trials: number;
    readonly scored_pairs: number;
    readonly censored_pairs: number;
    readonly censored_attempts: number;
  };
  readonly regression_case: {
    readonly case_id: string;
    readonly status: "active" | "retired";
  } | null;
  readonly applies_change: false;
}

function redactedText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted-private-key]",
    )
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]");
}

function contentId(prefix: string, canonicalValue: string): string {
  return `${prefix}-${createHash("sha256").update(canonicalValue).digest("hex").slice(0, 32)}`;
}

function domainEpisode(
  episodeId: string,
  input: ExplicitCorrectionEpisodeRequest,
): CorrectionEpisode {
  return {
    episode_id: episodeId,
    skill_id: input.skill_id,
    task: redactedText(input.task),
    observed_failure: redactedText(input.observed_failure),
    correction_intent: redactedText(input.correction_intent),
    pre_edit_revision: input.pre_edit_revision,
    post_edit_revision: input.post_edit_revision,
    bounded_diff: redactedText(input.bounded_diff),
    provenance: {
      harness: input.provenance.harness,
      trace_id: input.provenance.trace_id,
      session_id: input.provenance.session_id,
    },
  };
}

function domainVerifier(input: VerifierInstrumentRequest): VerifierInstrument {
  return {
    verifier_id: input.verifier_id,
    version: input.version,
    kind: input.kind,
    qualification: {
      rejects_known_failure: input.qualification.rejects_known_failure,
      accepts_known_good: input.qualification.accepts_known_good,
    },
  };
}

function domainTrials(
  input: ReadonlyArray<PairedReplayTrialRequest>,
): ReadonlyArray<PairedReplayTrial> {
  return input.map((trial) => ({
    pair_id: trial.pair_id,
    pre_edit: trial.pre_edit,
    post_edit: trial.post_edit,
  }));
}

function episodeIdentityForEpisode(input: ExplicitCorrectionEpisodeRequest): string {
  return JSON.stringify({
    skill_id: input.skill_id,
    trace_id: input.provenance.trace_id,
    session_id: input.provenance.session_id,
    pre_edit_revision: input.pre_edit_revision,
    post_edit_revision: input.post_edit_revision,
    correction_intent: redactedText(input.correction_intent),
    bounded_diff: redactedText(input.bounded_diff),
  });
}

function episodeIdentity(input: ExplicitCorrectionStudyRequest): string {
  return episodeIdentityForEpisode(input.episode);
}

function managedEpisodeIdentity(input: ManagedCorrectionStudyRequest): string {
  return JSON.stringify({
    episode_identity: episodeIdentityForEpisode(input.episode),
    task_case: input.task_case,
    current_revision: input.current_revision,
    runtime: input.runtime,
    verifier_manifest_id: input.qualified_verifier.manifest_id,
    required_scored_repetitions: input.required_scored_repetitions,
    max_attempts_per_arm: input.max_attempts_per_arm,
  });
}

function projectStudy(
  manifestId: string,
  replay: {
    readonly source: "externally_supplied" | "managed";
    readonly verified_by_selftune: boolean;
    readonly minimum_scored_trials: number;
    readonly scored_pairs: number;
    readonly censored_pairs: number;
    readonly censored_attempts: number;
  },
  study: PersistedCorrectionStudy,
): CorrectionStudyServiceResponse {
  return {
    episode_id: study.episode.episode_id,
    skill_id: study.episode.skill_id,
    skill_name: study.episode.skill_name,
    evidence_level: study.episode.evidence_level === "E1" ? "E1" : "E0.5",
    status:
      study.episode.status === "promoted" ||
      study.episode.status === "inconclusive" ||
      study.episode.status === "invalid"
        ? study.episode.status
        : "inconclusive",
    reason: study.episode.reason ?? "promoted",
    manifest_id: manifestId,
    replay: {
      ...replay,
    },
    regression_case: study.promoted_case
      ? {
          case_id: study.promoted_case.case_id,
          status: study.promoted_case.status,
        }
      : null,
    applies_change: false,
  };
}

function evidenceStatus(
  status: "promoted" | "inconclusive" | "invalid",
): "qualified" | "inconclusive" | "invalid" {
  if (status === "promoted") return "qualified";
  return status;
}

function parsePersistedJson(
  operation: string,
  value: string,
): Effect.Effect<unknown, CorrectionStudyServiceFailure> {
  return Effect.try({
    try: () => JSON.parse(value),
    catch: (cause) =>
      new CorrectionStudyServiceFailure({
        code: "CORRECTION_STUDY_PERSISTENCE_FAILED",
        message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
        status: 503,
      }),
  });
}

export const captureExplicitCorrectionStudy = Effect.fn(
  "CorrectionStudy.captureExplicitCorrection",
)(function* (database: Database, unknownInput: unknown) {
  const input = yield* Schema.decodeUnknownEffect(ExplicitCorrectionStudyRequest)(
    unknownInput,
  ).pipe(
    Effect.mapError(
      (error) =>
        new CorrectionStudyServiceFailure({
          code: "INVALID_CORRECTION_STUDY_REQUEST",
          message: error.message,
          status: 400,
        }),
    ),
  );
  const identity = episodeIdentity(input);
  const episodeId = contentId("correction-episode", identity);
  const episode = domainEpisode(episodeId, input.episode);
  const verifier = domainVerifier(input.verifier);
  const trials = domainTrials(input.trials);
  const evaluation = evaluateCorrectionStudy({
    episode,
    verifier,
    trials,
    ...(input.minimum_scored_trials === undefined
      ? {}
      : { minimum_scored_trials: input.minimum_scored_trials }),
  });
  const manifestJson = JSON.stringify({
    manifest_id: evaluation.manifest_id,
    execution_source: "externally_supplied",
    episode,
    verifier,
    minimum_scored_trials: evaluation.minimum_scored_trials,
    trials: [...trials].toSorted((left, right) => left.pair_id.localeCompare(right.pair_id)),
  });
  const verifierJson = JSON.stringify(verifier);
  const trialsJson = JSON.stringify(trials);
  const evidenceId = contentId(
    "correction-evidence",
    JSON.stringify({
      episode_id: episodeId,
      manifest_id: evaluation.manifest_id,
      status: evaluation.status,
      reason: evaluation.reason,
    }),
  );
  const reason = evaluation.reason;
  const ledgerStatus = evidenceStatus(evaluation.status);
  const persisted = yield* createOrGetCorrectionStudy(database, {
    episode: PersistedCorrectionEpisode.make({
      episode_id: episodeId,
      capture_key: episodeId,
      skill_id: input.episode.skill_id,
      skill_name: input.episode.skill_name,
      skill_path: input.episode.skill_path,
      harness: input.episode.provenance.harness,
      source_session_id: input.episode.provenance.session_id,
      pre_revision: input.episode.pre_edit_revision,
      post_revision: input.episode.post_edit_revision,
      manifest_json: manifestJson,
      correction_intent_json: JSON.stringify({
        correction_intent: episode.correction_intent,
        bounded_diff: episode.bounded_diff,
      }),
      trace_payload_json: JSON.stringify({
        task: episode.task,
        observed_failure: episode.observed_failure,
        provenance: episode.provenance,
      }),
      evidence_level: evaluation.evidence_level,
      status: evaluation.status,
      reason,
      captured_at: input.episode.captured_at,
      created_at: input.episode.captured_at,
      updated_at: input.episode.captured_at,
    }),
    evidence: CorrectionEvidenceLedgerEntry.make({
      evidence_id: evidenceId,
      skill_id: input.episode.skill_id,
      episode_id: episodeId,
      evidence_key: evaluation.manifest_id,
      evidence_level: evaluation.evidence_level,
      status: ledgerStatus,
      reason,
      manifest_json: manifestJson,
      verifier_payload_json: verifierJson,
      trial_payload_json: trialsJson,
      recorded_at: input.episode.captured_at,
    }),
    ...(evaluation.case_id === null
      ? {}
      : {
          promoted_case: PromotedStudyCase.make({
            case_id: evaluation.case_id,
            episode_id: episodeId,
            evidence_id: evidenceId,
            skill_id: input.episode.skill_id,
            skill_name: input.episode.skill_name,
            pre_revision: input.episode.pre_edit_revision,
            post_revision: input.episode.post_edit_revision,
            manifest_json: manifestJson,
            verifier_payload_json: verifierJson,
            trial_payload_json: trialsJson,
            evidence_level: "E1",
            status: "active",
            reason: null,
            promoted_at: input.episode.captured_at,
            created_at: input.episode.captured_at,
          }),
        }),
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CorrectionStudyPersistenceConflict
        ? new CorrectionStudyServiceFailure({
            code: "CORRECTION_EPISODE_CONFLICT",
            message: error.message,
            status: 409,
          })
        : new CorrectionStudyServiceFailure({
            code: "CORRECTION_STUDY_PERSISTENCE_FAILED",
            message: error.message,
            status: 503,
          }),
    ),
  );
  return projectStudy(
    evaluation.manifest_id,
    {
      source: "externally_supplied",
      verified_by_selftune: false,
      minimum_scored_trials: evaluation.minimum_scored_trials,
      scored_pairs: evaluation.scored_pairs,
      censored_pairs: evaluation.censored_pairs,
      censored_attempts: evaluation.censored_pairs,
    },
    persisted,
  );
});

/**
 * Runs the first-party, exact-revision replay and records its result. This is
 * evidence collection only: it neither edits nor applies a skill revision.
 */
export const captureManagedCorrectionStudy = Effect.fn("CorrectionStudy.captureManaged")(function* (
  database: Database,
  unknownInput: unknown,
  executor: PairedReplayArmExecutor,
) {
  const input = yield* Schema.decodeUnknownEffect(ManagedCorrectionStudyRequest)(unknownInput).pipe(
    Effect.mapError(
      (error) =>
        new CorrectionStudyServiceFailure({
          code: "INVALID_CORRECTION_STUDY_REQUEST",
          message: error.message,
          status: 400,
        }),
    ),
  );
  const episodeId = contentId("correction-episode", managedEpisodeIdentity(input));
  const episode = domainEpisode(episodeId, input.episode);
  const replay = yield* runManagedPairedReplay(
    {
      task_case: input.task_case,
      qualified_verifier: input.qualified_verifier,
      pre_edit_revision: input.episode.pre_edit_revision,
      post_edit_revision: input.episode.post_edit_revision,
      current_revision: input.current_revision,
      runtime: input.runtime,
      required_scored_repetitions: input.required_scored_repetitions,
      max_attempts_per_arm: input.max_attempts_per_arm,
    },
    executor,
  );
  const evidenceLevel = replay.status === "promoted" ? "E1" : "E0.5";
  const manifestJson = JSON.stringify({
    manifest_id: replay.manifest_id,
    run_id: replay.run_id,
    execution_source: "managed",
    managed: true,
    verified_by_selftune: true,
    episode,
    task_case: input.task_case,
    runtime: input.runtime,
    qualified_verifier: input.qualified_verifier,
    required_scored_repetitions: replay.required_scored_repetitions,
    infrastructure_census: {
      censored_attempts: replay.censored_attempts,
      censored_pairs: replay.trials.filter(
        (trial) =>
          trial.pre_edit === "infrastructure_error" || trial.post_edit === "infrastructure_error",
      ).length,
    },
  });
  const verifierJson = JSON.stringify(input.qualified_verifier);
  const trialsJson = JSON.stringify({
    managed: true,
    verified_by_selftune: true,
    status: replay.status,
    reason: replay.reason,
    censored_attempts: replay.censored_attempts,
    trials: replay.trials,
  });
  const evidenceId = contentId(
    "correction-evidence",
    JSON.stringify({
      episode_id: episodeId,
      manifest_id: replay.manifest_id,
      run_id: replay.run_id,
      status: replay.status,
      reason: replay.reason,
    }),
  );
  const persisted = yield* createOrGetCorrectionStudy(database, {
    episode: PersistedCorrectionEpisode.make({
      episode_id: episodeId,
      capture_key: episodeId,
      skill_id: input.episode.skill_id,
      skill_name: input.episode.skill_name,
      skill_path: input.episode.skill_path,
      harness: input.runtime.harness,
      source_session_id: input.episode.provenance.session_id,
      pre_revision: input.episode.pre_edit_revision,
      post_revision: input.episode.post_edit_revision,
      manifest_json: manifestJson,
      correction_intent_json: JSON.stringify({
        correction_intent: episode.correction_intent,
        bounded_diff: episode.bounded_diff,
      }),
      trace_payload_json: JSON.stringify({
        task: episode.task,
        observed_failure: episode.observed_failure,
        provenance: episode.provenance,
        task_case_id: input.task_case.case_id,
      }),
      evidence_level: evidenceLevel,
      status: replay.status,
      reason: replay.reason,
      captured_at: input.episode.captured_at,
      created_at: input.episode.captured_at,
      updated_at: input.episode.captured_at,
    }),
    evidence: CorrectionEvidenceLedgerEntry.make({
      evidence_id: evidenceId,
      skill_id: input.episode.skill_id,
      episode_id: episodeId,
      evidence_key: replay.manifest_id,
      evidence_level: evidenceLevel,
      status: evidenceStatus(replay.status),
      reason: replay.reason,
      manifest_json: manifestJson,
      verifier_payload_json: verifierJson,
      trial_payload_json: trialsJson,
      recorded_at: input.episode.captured_at,
    }),
    ...(replay.status !== "promoted"
      ? {}
      : {
          promoted_case: PromotedStudyCase.make({
            case_id: contentId("correction-case", replay.manifest_id),
            episode_id: episodeId,
            evidence_id: evidenceId,
            skill_id: input.episode.skill_id,
            skill_name: input.episode.skill_name,
            pre_revision: input.episode.pre_edit_revision,
            post_revision: input.episode.post_edit_revision,
            manifest_json: manifestJson,
            verifier_payload_json: verifierJson,
            trial_payload_json: trialsJson,
            evidence_level: "E1",
            status: "active",
            reason: null,
            promoted_at: input.episode.captured_at,
            created_at: input.episode.captured_at,
          }),
        }),
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CorrectionStudyPersistenceConflict
        ? new CorrectionStudyServiceFailure({
            code: "CORRECTION_EPISODE_CONFLICT",
            message: error.message,
            status: 409,
          })
        : new CorrectionStudyServiceFailure({
            code: "CORRECTION_STUDY_PERSISTENCE_FAILED",
            message: error.message,
            status: 503,
          }),
    ),
  );
  return projectStudy(
    replay.manifest_id,
    {
      source: "managed",
      verified_by_selftune: true,
      minimum_scored_trials: replay.required_scored_repetitions,
      scored_pairs: replay.scored_pairs,
      censored_pairs: replay.trials.filter(
        (trial) =>
          trial.pre_edit === "infrastructure_error" || trial.post_edit === "infrastructure_error",
      ).length,
      censored_attempts: replay.censored_attempts,
    },
    persisted,
  );
});

export const lookupCorrectionStudy = Effect.fn("CorrectionStudy.lookup")(function* (
  database: Database,
  episodeId: string,
) {
  const study = yield* getCorrectionStudy(database, episodeId).pipe(
    Effect.mapError(
      (error) =>
        new CorrectionStudyServiceFailure({
          code: "CORRECTION_STUDY_PERSISTENCE_FAILED",
          message: error.message,
          status: 503,
        }),
    ),
  );
  if (!study) {
    return yield* new CorrectionStudyServiceFailure({
      code: "CORRECTION_EPISODE_NOT_FOUND",
      message: "The correction episode does not exist.",
      status: 404,
    });
  }
  const evidence =
    study.promoted_case === null
      ? study.evidence_entries
          .toSorted((left, right) =>
            left.recorded_at === right.recorded_at
              ? left.evidence_id.localeCompare(right.evidence_id)
              : left.recorded_at.localeCompare(right.recorded_at),
          )
          .at(-1)
      : study.evidence_entries.find(
          (entry) => entry.evidence_id === study.promoted_case?.evidence_id,
        );
  if (!evidence) {
    return yield* new CorrectionStudyServiceFailure({
      code: "CORRECTION_STUDY_PERSISTENCE_FAILED",
      message: "The correction episode has no evidence ledger entry.",
      status: 503,
    });
  }
  const manifestJson = yield* parsePersistedJson(
    "decode persisted correction study manifest",
    evidence.manifest_json,
  );
  const manifest = yield* Schema.decodeUnknownEffect(
    Schema.Union([
      Schema.Struct({
        manifest_id: Identifier,
        execution_source: Schema.Literal("externally_supplied"),
        minimum_scored_trials: MinimumScoredTrials,
      }),
      Schema.Struct({
        manifest_id: Identifier,
        execution_source: Schema.Literal("managed"),
        managed: Schema.Literal(true),
        verified_by_selftune: Schema.Literal(true),
        required_scored_repetitions: MinimumScoredTrials,
        infrastructure_census: Schema.Struct({
          censored_attempts: Schema.Number,
          censored_pairs: Schema.Number,
        }),
      }),
    ]),
  )(manifestJson).pipe(
    Effect.mapError(
      (error) =>
        new CorrectionStudyServiceFailure({
          code: "CORRECTION_STUDY_PERSISTENCE_FAILED",
          message: error.message,
          status: 503,
        }),
    ),
  );
  const trialJson = yield* parsePersistedJson(
    "decode persisted correction replay trials",
    evidence.trial_payload_json,
  );
  const trialPayload = yield* Schema.decodeUnknownEffect(
    Schema.Union([
      Schema.Array(PairedReplayTrialRequest),
      Schema.Struct({
        managed: Schema.Literal(true),
        verified_by_selftune: Schema.Literal(true),
        censored_attempts: Schema.Number,
        trials: Schema.Array(
          Schema.Struct({
            pair_id: Identifier,
            pre_edit: Schema.Literals(["pass", "fail", "infrastructure_error", "skipped"]),
            post_edit: Schema.Literals(["pass", "fail", "infrastructure_error", "skipped"]),
          }),
        ),
      }),
    ]),
  )(trialJson).pipe(
    Effect.mapError(
      (error) =>
        new CorrectionStudyServiceFailure({
          code: "CORRECTION_STUDY_PERSISTENCE_FAILED",
          message: error.message,
          status: 503,
        }),
    ),
  );
  const trials = "trials" in trialPayload ? trialPayload.trials : trialPayload;
  const scoredPairs = trials.filter(
    (trial) =>
      (trial.pre_edit === "pass" || trial.pre_edit === "fail") &&
      (trial.post_edit === "pass" || trial.post_edit === "fail"),
  ).length;
  const managed = manifest.execution_source === "managed";
  return projectStudy(
    manifest.manifest_id,
    {
      source: managed ? "managed" : "externally_supplied",
      verified_by_selftune: managed,
      minimum_scored_trials: managed
        ? manifest.required_scored_repetitions
        : manifest.minimum_scored_trials,
      scored_pairs: scoredPairs,
      censored_pairs: managed
        ? manifest.infrastructure_census.censored_pairs
        : trials.length - scoredPairs,
      censored_attempts: managed
        ? manifest.infrastructure_census.censored_attempts
        : trials.length - scoredPairs,
    },
    study,
  );
});
