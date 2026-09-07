/**
 * Durable correction-study evidence for the local-first automatic learning
 * loop. SQLite owns the idempotent product lifecycle; source-native traces
 * and analytical facts remain with their existing owners.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getDrizzleDb } from "./db.js";
import {
  correction_episodes,
  correction_evidence_ledger_entries,
  correction_candidate_evaluations,
  promoted_study_cases,
  promoted_study_case_retirements,
} from "./drizzle-schema.js";

type StoredCandidateEvaluation = typeof correction_candidate_evaluations.$inferSelect;
type StoredCaseRetirement = typeof promoted_study_case_retirements.$inferSelect;

export interface PromotedStudyCaseRetirementInput {
  readonly retirement_id: string;
  readonly case_id: string;
  readonly actor: string;
  readonly reason: string;
  readonly prior_manifest_digest: string;
  readonly retired_at: string;
}

export interface CorrectionCandidateEvaluationInput {
  readonly evaluation_id: string;
  readonly candidate_id: string;
  readonly current_revision: string;
  readonly candidate_revision: string;
  readonly evidence_level: "E0" | "E0.5" | "E1" | "E2";
  readonly status: "selected" | "inconclusive" | "invalid";
  readonly reason?: string;
  readonly blind_manifest_json: string;
  readonly blind_result_json: string;
  readonly verifier_provenance: string;
  readonly runtime_provenance: string;
  readonly cost_estimate?: string;
  readonly cost_actual?: string;
  readonly recorded_at: string;
}

function validEvaluation(input: CorrectionCandidateEvaluationInput): void {
  if (
    ![input.evaluation_id, input.candidate_id].every((v) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
    ) ||
    !/^[a-f0-9]{64}$/.test(input.current_revision) ||
    !/^[a-f0-9]{64}$/.test(input.candidate_revision) ||
    input.current_revision === input.candidate_revision ||
    !Number.isFinite(Date.parse(input.recorded_at))
  )
    throw new Error("Invalid correction candidate evaluation identity.");
  if (
    (input.status === "selected" && input.evidence_level !== "E2") ||
    (input.status !== "selected" && input.evidence_level === "E2") ||
    ((input.status === "invalid" || input.status === "inconclusive") && !input.reason?.trim())
  )
    throw new Error("Invalid evaluation status, evidence, or reason.");
  for (const value of [
    input.blind_manifest_json,
    input.blind_result_json,
    input.verifier_provenance,
    input.runtime_provenance,
  ]) {
    if (value.length > 65_536) throw new Error("Evaluation payload exceeds its bound.");
    JSON.parse(value);
  }
  for (const value of [input.cost_estimate, input.cost_actual])
    if (
      value !== undefined &&
      (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(Number(value)))
    )
      throw new Error("Invalid evaluation cost.");
}

export function createOrGetCorrectionCandidateEvaluation(
  database: Database,
  input: CorrectionCandidateEvaluationInput,
) {
  validEvaluation(input);
  const values = [
    input.evaluation_id,
    input.candidate_id,
    input.current_revision,
    input.candidate_revision,
    input.evidence_level,
    input.status,
    input.reason ?? null,
    input.blind_manifest_json,
    input.blind_result_json,
    input.verifier_provenance,
    input.runtime_provenance,
    input.cost_estimate ?? null,
    input.cost_actual ?? null,
    "0",
    input.recorded_at,
  ];
  const existing = database
    .query<StoredCandidateEvaluation, [string]>(
      "SELECT * FROM correction_candidate_evaluations WHERE evaluation_id = ?",
    )
    .get(input.evaluation_id);
  if (existing) {
    if (JSON.stringify(Object.values(existing)) !== JSON.stringify(values))
      throw new Error("Correction candidate evaluation conflicts with immutable evidence.");
    return existing;
  }
  const candidate = database
    .query("SELECT candidate_id FROM correction_signal_candidates WHERE candidate_id = ?")
    .get(input.candidate_id);
  if (!candidate) throw new Error("Correction candidate does not exist.");
  database
    .query(
      "INSERT INTO correction_candidate_evaluations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(...values);
  return database
    .query<StoredCandidateEvaluation, [string]>(
      "SELECT * FROM correction_candidate_evaluations WHERE evaluation_id = ?",
    )
    .get(input.evaluation_id);
}

export function getCorrectionCandidateEvaluation(database: Database, evaluationId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evaluationId))
    throw new Error("Invalid evaluation id.");
  return database
    .query<StoredCandidateEvaluation, [string]>(
      "SELECT * FROM correction_candidate_evaluations WHERE evaluation_id = ?",
    )
    .get(evaluationId);
}

export function listLatestCorrectionCandidateEvaluations(
  database: Database,
  candidateId: string,
  limit = 50,
) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidateId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new Error("Invalid evaluation query.");
  return database
    .query<StoredCandidateEvaluation, [string, number]>(
      "SELECT * FROM correction_candidate_evaluations WHERE candidate_id = ? ORDER BY recorded_at DESC, evaluation_id ASC LIMIT ?",
    )
    .all(candidateId, limit);
}

export function listActivePromotedStudyCases(database: Database, skillId: string, limit = 50) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(skillId)) throw new Error("Invalid skill id.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid case limit.");
  return database
    .query<StoredPromotedStudyCase, [string, number]>(
      "SELECT * FROM promoted_study_cases WHERE skill_id = ? AND status = 'active' ORDER BY promoted_at DESC, case_id ASC LIMIT ?",
    )
    .all(skillId, limit);
}

export function listPromotedStudyCaseRetirements(database: Database, caseId: string, limit = 50) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(caseId)) throw new Error("Invalid case id.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid retirement limit.");
  return database
    .query<StoredCaseRetirement, [string, number]>(
      "SELECT * FROM promoted_study_case_retirements WHERE case_id = ? ORDER BY retired_at DESC LIMIT ?",
    )
    .all(caseId, limit);
}

export function retirePromotedStudyCase(
  database: Database,
  input: PromotedStudyCaseRetirementInput,
): void {
  if (
    ![input.retirement_id, input.case_id, input.actor].every((value) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
    )
  )
    throw new Error("Invalid retirement identity.");
  if (
    !input.reason.trim() ||
    !/^sha256:[a-f0-9]{64}$/.test(input.prior_manifest_digest) ||
    !Number.isFinite(Date.parse(input.retired_at))
  )
    throw new Error(
      "A retirement requires actor, reason, timestamp, and prior manifest provenance.",
    );
  database.transaction(() => {
    const current = database
      .query<{ status: string; manifest_json: string }, [string]>(
        "SELECT status, manifest_json FROM promoted_study_cases WHERE case_id = ?",
      )
      .get(input.case_id);
    if (!current) throw new Error("Promoted StudyCase does not exist.");
    const digest = `sha256:${createHash("sha256").update(current.manifest_json).digest("hex")}`;
    if (digest !== input.prior_manifest_digest)
      throw new Error("Retirement must cite the exact prior manifest.");
    const prior = database
      .query<{ retirement_id: string }, [string]>(
        "SELECT retirement_id FROM promoted_study_case_retirements WHERE case_id = ?",
      )
      .get(input.case_id);
    if (prior) {
      const same = database
        .query<StoredCaseRetirement, [string]>(
          "SELECT * FROM promoted_study_case_retirements WHERE case_id = ?",
        )
        .get(input.case_id);
      if (
        same?.retirement_id === input.retirement_id &&
        same.actor === input.actor &&
        same.reason === input.reason &&
        same.prior_manifest_digest === input.prior_manifest_digest &&
        same.retired_at === input.retired_at
      )
        return;
      throw new Error("Promoted StudyCase already has an immutable retirement receipt.");
    }
    if (current.status !== "active")
      throw new Error("Only an active Promoted StudyCase may retire.");
    database
      .query("INSERT INTO promoted_study_case_retirements VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        input.retirement_id,
        input.case_id,
        input.actor,
        input.reason,
        input.prior_manifest_digest,
        input.retired_at,
      );
    database
      .query("UPDATE promoted_study_cases SET status = 'retired', reason = ? WHERE case_id = ?")
      .run(input.reason, input.case_id);
  })();
}

const CensoredAttempts = Schema.fromJsonString(
  Schema.Struct({
    censored_attempts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
);

export function queryCorrectionPipelineMetrics(database: Database, limit = 200) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid metric limit.");
  const count = (sql: string) => database.query<{ count: number }, []>(sql).get()?.count ?? 0;
  const infrastructure_censored_attempts = database
    .query<{ trial_payload_json: string }, [number]>(
      "SELECT trial_payload_json FROM correction_evidence_ledger_entries ORDER BY recorded_at DESC LIMIT ?",
    )
    .all(limit)
    .reduce((sum, row) => {
      try {
        const parsed = Schema.decodeUnknownSync(CensoredAttempts)(row.trial_payload_json);
        return sum + parsed.censored_attempts;
      } catch {
        return sum;
      }
    }, 0);
  return {
    capture_candidates: count("SELECT COUNT(*) AS count FROM correction_signal_candidates"),
    drafts: count("SELECT COUNT(*) AS count FROM correction_study_drafts"),
    verifier_replay_evidence: count(
      "SELECT COUNT(*) AS count FROM correction_evidence_ledger_entries",
    ),
    promoted_regressions: count(
      "SELECT COUNT(*) AS count FROM promoted_study_cases WHERE status = 'active'",
    ),
    invalid_or_inconclusive: count(
      "SELECT COUNT(*) AS count FROM correction_evidence_ledger_entries WHERE status IN ('invalid', 'inconclusive')",
    ),
    review_decisions: count("SELECT COUNT(*) AS count FROM correction_review_decisions"),
    infrastructure_censored_attempts,
  };
}

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const SkillName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const SkillPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));
const Harness = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const SkillRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Timestamp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const OpaqueJson = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536));
const Reason = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));

export const CorrectionEvidenceLevel = Schema.Literals(["E0", "E0.5", "E1", "E2", "E3"]);
export const CorrectionEpisodeStatus = Schema.Literals([
  "captured",
  "inconclusive",
  "invalid",
  "promoted",
]);
export const CorrectionEvidenceStatus = Schema.Literals([
  "recorded",
  "inconclusive",
  "invalid",
  "qualified",
]);
export const PromotedStudyCaseStatus = Schema.Literals(["active", "retired"]);

export class CorrectionEpisode extends Schema.Class<CorrectionEpisode>("CorrectionEpisode")({
  episode_id: Identifier,
  capture_key: Identifier,
  skill_id: Identifier,
  skill_name: SkillName,
  skill_path: SkillPath,
  harness: Harness,
  source_session_id: Identifier,
  pre_revision: SkillRevision,
  post_revision: SkillRevision,
  manifest_json: OpaqueJson,
  correction_intent_json: OpaqueJson,
  trace_payload_json: OpaqueJson,
  evidence_level: CorrectionEvidenceLevel,
  status: CorrectionEpisodeStatus,
  reason: Schema.NullOr(Reason),
  captured_at: Timestamp,
  created_at: Timestamp,
  updated_at: Timestamp,
}) {}

export class CorrectionEvidenceLedgerEntry extends Schema.Class<CorrectionEvidenceLedgerEntry>(
  "CorrectionEvidenceLedgerEntry",
)({
  evidence_id: Identifier,
  skill_id: Identifier,
  episode_id: Identifier,
  evidence_key: Identifier,
  evidence_level: CorrectionEvidenceLevel,
  status: CorrectionEvidenceStatus,
  reason: Schema.NullOr(Reason),
  manifest_json: OpaqueJson,
  verifier_payload_json: OpaqueJson,
  trial_payload_json: OpaqueJson,
  recorded_at: Timestamp,
}) {}

export class PromotedStudyCase extends Schema.Class<PromotedStudyCase>("PromotedStudyCase")({
  case_id: Identifier,
  episode_id: Identifier,
  evidence_id: Identifier,
  skill_id: Identifier,
  skill_name: SkillName,
  pre_revision: SkillRevision,
  post_revision: SkillRevision,
  manifest_json: OpaqueJson,
  verifier_payload_json: OpaqueJson,
  trial_payload_json: OpaqueJson,
  evidence_level: CorrectionEvidenceLevel,
  status: PromotedStudyCaseStatus,
  reason: Schema.NullOr(Reason),
  promoted_at: Timestamp,
  created_at: Timestamp,
}) {}

export class CreateOrGetCorrectionStudy extends Schema.Class<CreateOrGetCorrectionStudy>(
  "CreateOrGetCorrectionStudy",
)({
  episode: CorrectionEpisode,
  evidence: CorrectionEvidenceLedgerEntry,
  promoted_case: Schema.optionalKey(PromotedStudyCase),
}) {}

export class CorrectionStudy extends Schema.Class<CorrectionStudy>("CorrectionStudy")({
  episode: CorrectionEpisode,
  evidence_entries: Schema.Array(CorrectionEvidenceLedgerEntry),
  promoted_case: Schema.NullOr(PromotedStudyCase),
}) {}

export class CorrectionStudyPersistenceFailure extends Schema.TaggedErrorClass<CorrectionStudyPersistenceFailure>()(
  "CorrectionStudyPersistenceFailure",
  { operation: Schema.String, message: Schema.String },
) {}

export class CorrectionStudyPersistenceConflict extends Schema.TaggedErrorClass<CorrectionStudyPersistenceConflict>()(
  "CorrectionStudyPersistenceConflict",
  { operation: Schema.String, message: Schema.String },
) {}

type CorrectionStudyError = CorrectionStudyPersistenceFailure | CorrectionStudyPersistenceConflict;
type StoredCorrectionEpisode = typeof correction_episodes.$inferSelect;
type StoredCorrectionEvidence = typeof correction_evidence_ledger_entries.$inferSelect;
type StoredPromotedStudyCase = typeof promoted_study_cases.$inferSelect;

function failure(operation: string, cause: unknown): CorrectionStudyError {
  if (cause instanceof CorrectionStudyPersistenceConflict) return cause;
  if (cause instanceof CorrectionStudyPersistenceFailure) return cause;
  return new CorrectionStudyPersistenceFailure({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const decodingFailure = (operation: string) =>
  Effect.mapError(
    (error: Schema.SchemaError) =>
      new CorrectionStudyPersistenceFailure({ operation, message: error.message }),
  );

function validateJson(
  operation: string,
  payload: string,
): Effect.Effect<void, CorrectionStudyPersistenceFailure> {
  return Effect.try({
    try: () => {
      JSON.parse(payload);
    },
    catch: (cause) =>
      new CorrectionStudyPersistenceFailure({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

function episodeMatches(existing: StoredCorrectionEpisode, input: CorrectionEpisode): boolean {
  return (
    existing.episode_id === input.episode_id &&
    existing.capture_key === input.capture_key &&
    existing.skill_id === input.skill_id &&
    existing.skill_name === input.skill_name &&
    existing.skill_path === input.skill_path &&
    existing.harness === input.harness &&
    existing.source_session_id === input.source_session_id &&
    existing.pre_revision === input.pre_revision &&
    existing.post_revision === input.post_revision &&
    existing.manifest_json === input.manifest_json &&
    existing.correction_intent_json === input.correction_intent_json &&
    existing.trace_payload_json === input.trace_payload_json &&
    existing.evidence_level === input.evidence_level &&
    existing.status === input.status &&
    existing.reason === input.reason &&
    existing.captured_at === input.captured_at &&
    existing.created_at === input.created_at &&
    existing.updated_at === input.updated_at
  );
}

function evidenceMatches(
  existing: StoredCorrectionEvidence,
  input: CorrectionEvidenceLedgerEntry,
): boolean {
  return (
    existing.evidence_id === input.evidence_id &&
    existing.skill_id === input.skill_id &&
    existing.episode_id === input.episode_id &&
    existing.evidence_key === input.evidence_key &&
    existing.evidence_level === input.evidence_level &&
    existing.status === input.status &&
    existing.reason === input.reason &&
    existing.manifest_json === input.manifest_json &&
    existing.verifier_payload_json === input.verifier_payload_json &&
    existing.trial_payload_json === input.trial_payload_json &&
    existing.recorded_at === input.recorded_at
  );
}

function caseMatches(existing: StoredPromotedStudyCase, input: PromotedStudyCase): boolean {
  return (
    existing.case_id === input.case_id &&
    existing.episode_id === input.episode_id &&
    existing.evidence_id === input.evidence_id &&
    existing.skill_id === input.skill_id &&
    existing.skill_name === input.skill_name &&
    existing.pre_revision === input.pre_revision &&
    existing.post_revision === input.post_revision &&
    existing.manifest_json === input.manifest_json &&
    existing.verifier_payload_json === input.verifier_payload_json &&
    existing.trial_payload_json === input.trial_payload_json &&
    existing.evidence_level === input.evidence_level &&
    existing.status === input.status &&
    existing.reason === input.reason &&
    existing.promoted_at === input.promoted_at &&
    existing.created_at === input.created_at
  );
}

function assertPromotionConsistency(
  input: CreateOrGetCorrectionStudy,
): Effect.Effect<void, CorrectionStudyPersistenceFailure> {
  const promotedCase = input.promoted_case;
  if (!promotedCase) return Effect.void;
  if (
    promotedCase.episode_id !== input.episode.episode_id ||
    promotedCase.evidence_id !== input.evidence.evidence_id ||
    promotedCase.skill_id !== input.episode.skill_id ||
    input.evidence.skill_id !== input.episode.skill_id ||
    promotedCase.skill_name !== input.episode.skill_name ||
    promotedCase.pre_revision !== input.episode.pre_revision ||
    promotedCase.post_revision !== input.episode.post_revision ||
    promotedCase.manifest_json !== input.evidence.manifest_json ||
    promotedCase.verifier_payload_json !== input.evidence.verifier_payload_json ||
    promotedCase.trial_payload_json !== input.evidence.trial_payload_json ||
    input.evidence.status !== "qualified"
  ) {
    return Effect.fail(
      new CorrectionStudyPersistenceFailure({
        operation: "validate promoted study case",
        message: "The promoted study case must exactly reference a qualified evidence entry.",
      }),
    );
  }
  return Effect.void;
}

function validateStudyJson(
  input: CreateOrGetCorrectionStudy,
): Effect.Effect<void, CorrectionStudyPersistenceFailure> {
  const payloads: ReadonlyArray<readonly [operation: string, payload: string]> = [
    ["validate correction episode manifest", input.episode.manifest_json],
    ["validate correction intent", input.episode.correction_intent_json],
    ["validate correction trace payload", input.episode.trace_payload_json],
    ["validate evidence manifest", input.evidence.manifest_json],
    ["validate verifier payload", input.evidence.verifier_payload_json],
    ["validate trial payload", input.evidence.trial_payload_json],
  ];
  const promotedCase = input.promoted_case;
  const promotedPayloads = promotedCase
    ? ([
        ["validate promoted case manifest", promotedCase.manifest_json],
        ["validate promoted case verifier payload", promotedCase.verifier_payload_json],
        ["validate promoted case trial payload", promotedCase.trial_payload_json],
      ] satisfies ReadonlyArray<readonly [operation: string, payload: string]>)
    : ([] satisfies ReadonlyArray<readonly [operation: string, payload: string]>);
  return Effect.forEach([...payloads, ...promotedPayloads], ([operation, payload]) =>
    validateJson(operation, payload),
  ).pipe(Effect.asVoid);
}

/** Read an episode, its append-only ledger, and its optional promoted case. */
export const getCorrectionStudy = Effect.fn("LocalStore.getCorrectionStudy")(function* (
  database: Database,
  requestedEpisodeId: string,
) {
  const episodeId = yield* Schema.decodeUnknownEffect(Identifier)(requestedEpisodeId).pipe(
    decodingFailure("decode correction episode id"),
  );
  const persisted = yield* Effect.try({
    try: () => {
      const drizzle = getDrizzleDb(database);
      return {
        episode: drizzle
          .select()
          .from(correction_episodes)
          .where(eq(correction_episodes.episode_id, episodeId))
          .get(),
        evidence: drizzle
          .select()
          .from(correction_evidence_ledger_entries)
          .where(eq(correction_evidence_ledger_entries.episode_id, episodeId))
          .all(),
        promotedCase: drizzle
          .select()
          .from(promoted_study_cases)
          .where(eq(promoted_study_cases.episode_id, episodeId))
          .get(),
      };
    },
    catch: (cause) => failure("get correction study", cause),
  });
  if (!persisted.episode) return null;
  const episode = yield* Schema.decodeUnknownEffect(CorrectionEpisode)(persisted.episode).pipe(
    decodingFailure("decode persisted correction episode"),
  );
  const evidenceEntries = yield* Effect.forEach(persisted.evidence, (entry) =>
    Schema.decodeUnknownEffect(CorrectionEvidenceLedgerEntry)(entry).pipe(
      decodingFailure("decode persisted correction evidence"),
    ),
  );
  const promotedCase = persisted.promotedCase
    ? yield* Schema.decodeUnknownEffect(PromotedStudyCase)(persisted.promotedCase).pipe(
        decodingFailure("decode persisted promoted study case"),
      )
    : null;
  return new CorrectionStudy({
    episode,
    evidence_entries: evidenceEntries,
    promoted_case: promotedCase,
  });
});

/**
 * Atomically records one deterministic capture result. Replaying the same
 * episode, evidence, and case returns the existing durable records. Any
 * conflicting reuse of a deterministic identifier fails instead of mutating
 * the original evidence.
 */
export const createOrGetCorrectionStudy = Effect.fn("LocalStore.createOrGetCorrectionStudy")(
  function* (database: Database, request: CreateOrGetCorrectionStudy) {
    const input = yield* Schema.decodeUnknownEffect(CreateOrGetCorrectionStudy)(request).pipe(
      decodingFailure("decode correction study"),
    );
    yield* assertPromotionConsistency(input);
    yield* validateStudyJson(input);

    yield* Effect.try({
      try: () => {
        const drizzle = getDrizzleDb(database);
        return drizzle.transaction((transaction) => {
          const episodeById = transaction
            .select()
            .from(correction_episodes)
            .where(eq(correction_episodes.episode_id, input.episode.episode_id))
            .get();
          const episodeByCaptureKey = transaction
            .select()
            .from(correction_episodes)
            .where(eq(correction_episodes.capture_key, input.episode.capture_key))
            .get();
          const evidenceById = transaction
            .select()
            .from(correction_evidence_ledger_entries)
            .where(eq(correction_evidence_ledger_entries.evidence_id, input.evidence.evidence_id))
            .get();
          const evidenceByKey = transaction
            .select()
            .from(correction_evidence_ledger_entries)
            .where(eq(correction_evidence_ledger_entries.episode_id, input.evidence.episode_id))
            .all()
            .find((entry) => entry.evidence_key === input.evidence.evidence_key);
          const caseById = input.promoted_case
            ? transaction
                .select()
                .from(promoted_study_cases)
                .where(eq(promoted_study_cases.case_id, input.promoted_case.case_id))
                .get()
            : undefined;
          const caseByEpisode = input.promoted_case
            ? transaction
                .select()
                .from(promoted_study_cases)
                .where(eq(promoted_study_cases.episode_id, input.promoted_case.episode_id))
                .get()
            : undefined;

          if (
            (episodeById && !episodeMatches(episodeById, input.episode)) ||
            (episodeByCaptureKey && !episodeMatches(episodeByCaptureKey, input.episode))
          ) {
            throw new CorrectionStudyPersistenceConflict({
              operation: "create or get correction study",
              message:
                "A correction episode identifier is already bound to different immutable evidence.",
            });
          }
          if (
            (evidenceById && !evidenceMatches(evidenceById, input.evidence)) ||
            (evidenceByKey && !evidenceMatches(evidenceByKey, input.evidence))
          ) {
            throw new CorrectionStudyPersistenceConflict({
              operation: "create or get correction study",
              message:
                "A correction evidence identifier is already bound to a different immutable result.",
            });
          }
          if (
            input.promoted_case &&
            ((caseById && !caseMatches(caseById, input.promoted_case)) ||
              (caseByEpisode && !caseMatches(caseByEpisode, input.promoted_case)))
          ) {
            throw new CorrectionStudyPersistenceConflict({
              operation: "create or get correction study",
              message:
                "A promoted study case identifier is already bound to different immutable evidence.",
            });
          }

          transaction.insert(correction_episodes).values(input.episode).onConflictDoNothing().run();
          transaction
            .insert(correction_evidence_ledger_entries)
            .values(input.evidence)
            .onConflictDoNothing()
            .run();
          if (input.promoted_case) {
            transaction
              .insert(promoted_study_cases)
              .values(input.promoted_case)
              .onConflictDoNothing()
              .run();
          }

          const persistedEpisode = transaction
            .select()
            .from(correction_episodes)
            .where(eq(correction_episodes.episode_id, input.episode.episode_id))
            .get();
          const persistedEvidence = transaction
            .select()
            .from(correction_evidence_ledger_entries)
            .where(eq(correction_evidence_ledger_entries.evidence_id, input.evidence.evidence_id))
            .get();
          const persistedCase = input.promoted_case
            ? transaction
                .select()
                .from(promoted_study_cases)
                .where(eq(promoted_study_cases.case_id, input.promoted_case.case_id))
                .get()
            : undefined;
          if (
            !persistedEpisode ||
            !episodeMatches(persistedEpisode, input.episode) ||
            !persistedEvidence ||
            !evidenceMatches(persistedEvidence, input.evidence) ||
            (input.promoted_case &&
              (!persistedCase || !caseMatches(persistedCase, input.promoted_case)))
          ) {
            throw new CorrectionStudyPersistenceConflict({
              operation: "create or get correction study",
              message: "A concurrent correction-study write conflicted with immutable evidence.",
            });
          }
        });
      },
      catch: (cause) => failure("create or get correction study", cause),
    });

    const persistedEpisode = yield* Effect.try({
      try: () =>
        getDrizzleDb(database)
          .select({ episode_id: correction_episodes.episode_id })
          .from(correction_episodes)
          .where(eq(correction_episodes.capture_key, input.episode.capture_key))
          .get(),
      catch: (cause) => failure("read correction study after persistence", cause),
    });
    if (!persistedEpisode) {
      return yield* new CorrectionStudyPersistenceFailure({
        operation: "create or get correction study",
        message: "The correction episode capture key was not found after persistence.",
      });
    }
    const study = yield* getCorrectionStudy(database, persistedEpisode.episode_id);
    if (!study) {
      return yield* new CorrectionStudyPersistenceFailure({
        operation: "create or get correction study",
        message: "The correction episode was not found after persistence.",
      });
    }
    if (!episodeMatches(study.episode, input.episode)) {
      return yield* new CorrectionStudyPersistenceConflict({
        operation: "create or get correction study",
        message:
          "The correction capture key is already bound to different immutable episode evidence.",
      });
    }
    const evidence = study.evidence_entries.find(
      (entry) => entry.evidence_key === input.evidence.evidence_key,
    );
    if (!evidence || !evidenceMatches(evidence, input.evidence)) {
      return yield* new CorrectionStudyPersistenceConflict({
        operation: "create or get correction study",
        message: "The correction evidence key is already bound to a different immutable result.",
      });
    }
    if (input.promoted_case) {
      if (!study.promoted_case || !caseMatches(study.promoted_case, input.promoted_case)) {
        return yield* new CorrectionStudyPersistenceConflict({
          operation: "create or get correction study",
          message: "The correction episode is already bound to a different promoted study case.",
        });
      }
    }
    return study;
  },
);
