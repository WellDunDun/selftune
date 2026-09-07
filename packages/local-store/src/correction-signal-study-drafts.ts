/**
 * Review-only durable state for automatically recovered correction signals.
 * E0/E0.5 candidates and StudyDrafts are hypotheses: this repository has no
 * promotion, replay execution, candidate mutation, or application surface.
 */
import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getDrizzleDb } from "./db.js";
import { correction_signal_candidates, correction_study_drafts } from "./drizzle-schema.js";

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const SkillName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const SkillRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
);
const OpaqueJson = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536));
const Reason = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));
const Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

export const CorrectionSignalEvidenceLevel = Schema.Literals(["E0", "E0.5"]);
export const CorrectionSignalLifecycle = Schema.Literals([
  "detected",
  "review_ready",
  "deferred",
  "dismissed",
]);
export const CorrectionStudyDraftLifecycle = Schema.Literals([
  "prepared",
  "review_ready",
  "deferred",
  "invalid",
]);

export class CorrectionSignalCandidate extends Schema.Class<CorrectionSignalCandidate>(
  "CorrectionSignalCandidate",
)({
  candidate_id: Identifier,
  idempotency_key: Identifier,
  skill_id: Identifier,
  skill_name: SkillName,
  source_session_id: Identifier,
  evidence_level: CorrectionSignalEvidenceLevel,
  lifecycle: CorrectionSignalLifecycle,
  reason: Schema.NullOr(Reason),
  manifest_digest: Digest,
  signal_payload_digest: Digest,
  signal_payload_json: OpaqueJson,
  created_at: Timestamp,
  updated_at: Timestamp,
}) {}

export class CorrectionStudyDraft extends Schema.Class<CorrectionStudyDraft>(
  "CorrectionStudyDraft",
)({
  draft_id: Identifier,
  idempotency_key: Identifier,
  candidate_id: Identifier,
  skill_id: Identifier,
  skill_name: SkillName,
  source_revision: Schema.NullOr(SkillRevision),
  evidence_level: CorrectionSignalEvidenceLevel,
  lifecycle: CorrectionStudyDraftLifecycle,
  reason: Schema.NullOr(Reason),
  manifest_digest: Digest,
  study_payload_digest: Digest,
  study_payload_json: OpaqueJson,
  created_at: Timestamp,
  updated_at: Timestamp,
}) {}

export class ListCorrectionSignalCandidates extends Schema.Class<ListCorrectionSignalCandidates>(
  "ListCorrectionSignalCandidates",
)({
  skill_id: Schema.optionalKey(Identifier),
  lifecycle: Schema.optionalKey(CorrectionSignalLifecycle),
  limit: Schema.optionalKey(Limit),
}) {}

export class ListCorrectionStudyDrafts extends Schema.Class<ListCorrectionStudyDrafts>(
  "ListCorrectionStudyDrafts",
)({
  skill_id: Schema.optionalKey(Identifier),
  lifecycle: Schema.optionalKey(CorrectionStudyDraftLifecycle),
  limit: Schema.optionalKey(Limit),
}) {}

export class CorrectionSignalStudyDraftFailure extends Schema.TaggedErrorClass<CorrectionSignalStudyDraftFailure>()(
  "CorrectionSignalStudyDraftFailure",
  { operation: Schema.String, message: Schema.String },
) {}

export class CorrectionSignalStudyDraftConflict extends Schema.TaggedErrorClass<CorrectionSignalStudyDraftConflict>()(
  "CorrectionSignalStudyDraftConflict",
  { operation: Schema.String, message: Schema.String },
) {}

type PersistenceError = CorrectionSignalStudyDraftFailure | CorrectionSignalStudyDraftConflict;
type StoredCandidate = typeof correction_signal_candidates.$inferSelect;
type StoredDraft = typeof correction_study_drafts.$inferSelect;

function failure(operation: string, cause: unknown): PersistenceError {
  if (cause instanceof CorrectionSignalStudyDraftFailure) return cause;
  if (cause instanceof CorrectionSignalStudyDraftConflict) return cause;
  return new CorrectionSignalStudyDraftFailure({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const decodingFailure = (operation: string) =>
  Effect.mapError(
    (error: Schema.SchemaError) =>
      new CorrectionSignalStudyDraftFailure({ operation, message: error.message }),
  );

function validatePayload(
  operation: string,
  payload: string,
  digest: string,
): Effect.Effect<void, CorrectionSignalStudyDraftFailure> {
  return Effect.try({
    try: () => {
      JSON.parse(payload);
      const actualDigest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
      if (actualDigest !== digest) {
        throw new Error("The payload digest does not match the supplied JSON payload.");
      }
    },
    catch: (cause) =>
      new CorrectionSignalStudyDraftFailure({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

function candidateMatchesImmutable(
  existing: StoredCandidate,
  input: CorrectionSignalCandidate,
): boolean {
  return (
    existing.candidate_id === input.candidate_id &&
    existing.idempotency_key === input.idempotency_key &&
    existing.skill_id === input.skill_id &&
    existing.skill_name === input.skill_name &&
    existing.source_session_id === input.source_session_id &&
    existing.evidence_level === input.evidence_level &&
    existing.manifest_digest === input.manifest_digest &&
    existing.signal_payload_digest === input.signal_payload_digest &&
    existing.signal_payload_json === input.signal_payload_json &&
    existing.created_at === input.created_at
  );
}

function draftMatchesImmutable(existing: StoredDraft, input: CorrectionStudyDraft): boolean {
  return (
    existing.draft_id === input.draft_id &&
    existing.idempotency_key === input.idempotency_key &&
    existing.candidate_id === input.candidate_id &&
    existing.skill_id === input.skill_id &&
    existing.skill_name === input.skill_name &&
    existing.source_revision === input.source_revision &&
    existing.evidence_level === input.evidence_level &&
    existing.manifest_digest === input.manifest_digest &&
    existing.study_payload_digest === input.study_payload_digest &&
    existing.study_payload_json === input.study_payload_json &&
    existing.created_at === input.created_at
  );
}

function getCandidateRow(database: Database, candidateId: string): StoredCandidate | undefined {
  return getDrizzleDb(database)
    .select()
    .from(correction_signal_candidates)
    .where(eq(correction_signal_candidates.candidate_id, candidateId))
    .get();
}

function getDraftRow(database: Database, draftId: string): StoredDraft | undefined {
  return getDrizzleDb(database)
    .select()
    .from(correction_study_drafts)
    .where(eq(correction_study_drafts.draft_id, draftId))
    .get();
}

export const getCorrectionSignalCandidate = Effect.fn("LocalStore.getCorrectionSignalCandidate")(
  function* (database: Database, id: string) {
    const candidateId = yield* Schema.decodeUnknownEffect(Identifier)(id).pipe(
      decodingFailure("decode correction signal candidate id"),
    );
    const row = yield* Effect.try({
      try: () => getCandidateRow(database, candidateId),
      catch: (cause) => failure("get correction signal candidate", cause),
    });
    return row
      ? yield* Schema.decodeUnknownEffect(CorrectionSignalCandidate)(row).pipe(
          decodingFailure("decode persisted correction signal candidate"),
        )
      : null;
  },
);

export const getCorrectionStudyDraft = Effect.fn("LocalStore.getCorrectionStudyDraft")(function* (
  database: Database,
  id: string,
) {
  const draftId = yield* Schema.decodeUnknownEffect(Identifier)(id).pipe(
    decodingFailure("decode correction study draft id"),
  );
  const row = yield* Effect.try({
    try: () => getDraftRow(database, draftId),
    catch: (cause) => failure("get correction study draft", cause),
  });
  return row
    ? yield* Schema.decodeUnknownEffect(CorrectionStudyDraft)(row).pipe(
        decodingFailure("decode persisted correction study draft"),
      )
    : null;
});

export const listCorrectionSignalCandidates = Effect.fn(
  "LocalStore.listCorrectionSignalCandidates",
)(function* (database: Database, input: ListCorrectionSignalCandidates = {}) {
  const query = yield* Schema.decodeUnknownEffect(ListCorrectionSignalCandidates)(input).pipe(
    decodingFailure("decode correction signal candidate list"),
  );
  const rows = yield* Effect.try({
    try: () => {
      const databaseQuery = getDrizzleDb(database).select().from(correction_signal_candidates);
      if (query.skill_id && query.lifecycle) {
        return databaseQuery
          .where(
            and(
              eq(correction_signal_candidates.skill_id, query.skill_id),
              eq(correction_signal_candidates.lifecycle, query.lifecycle),
            ),
          )
          .orderBy(desc(correction_signal_candidates.updated_at))
          .limit(query.limit ?? 50)
          .all();
      }
      if (query.skill_id) {
        return databaseQuery
          .where(eq(correction_signal_candidates.skill_id, query.skill_id))
          .orderBy(desc(correction_signal_candidates.updated_at))
          .limit(query.limit ?? 50)
          .all();
      }
      if (query.lifecycle) {
        return databaseQuery
          .where(eq(correction_signal_candidates.lifecycle, query.lifecycle))
          .orderBy(desc(correction_signal_candidates.updated_at))
          .limit(query.limit ?? 50)
          .all();
      }
      return databaseQuery
        .orderBy(desc(correction_signal_candidates.updated_at))
        .limit(query.limit ?? 50)
        .all();
    },
    catch: (cause) => failure("list correction signal candidates", cause),
  });
  const decoded = yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(CorrectionSignalCandidate)(row).pipe(
      decodingFailure("decode persisted correction signal candidate"),
    ),
  );
  return decoded;
});

export const listCorrectionStudyDrafts = Effect.fn("LocalStore.listCorrectionStudyDrafts")(
  function* (database: Database, input: ListCorrectionStudyDrafts = {}) {
    const query = yield* Schema.decodeUnknownEffect(ListCorrectionStudyDrafts)(input).pipe(
      decodingFailure("decode correction study draft list"),
    );
    const rows = yield* Effect.try({
      try: () => {
        const databaseQuery = getDrizzleDb(database).select().from(correction_study_drafts);
        if (query.skill_id && query.lifecycle) {
          return databaseQuery
            .where(
              and(
                eq(correction_study_drafts.skill_id, query.skill_id),
                eq(correction_study_drafts.lifecycle, query.lifecycle),
              ),
            )
            .orderBy(desc(correction_study_drafts.updated_at))
            .limit(query.limit ?? 50)
            .all();
        }
        if (query.skill_id) {
          return databaseQuery
            .where(eq(correction_study_drafts.skill_id, query.skill_id))
            .orderBy(desc(correction_study_drafts.updated_at))
            .limit(query.limit ?? 50)
            .all();
        }
        if (query.lifecycle) {
          return databaseQuery
            .where(eq(correction_study_drafts.lifecycle, query.lifecycle))
            .orderBy(desc(correction_study_drafts.updated_at))
            .limit(query.limit ?? 50)
            .all();
        }
        return databaseQuery
          .orderBy(desc(correction_study_drafts.updated_at))
          .limit(query.limit ?? 50)
          .all();
      },
      catch: (cause) => failure("list correction study drafts", cause),
    });
    const decoded = yield* Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(CorrectionStudyDraft)(row).pipe(
        decodingFailure("decode persisted correction study draft"),
      ),
    );
    return decoded;
  },
);

/** Upserts only review state; payloads and manifest digests are immutable. */
export const upsertCorrectionSignalCandidate = Effect.fn(
  "LocalStore.upsertCorrectionSignalCandidate",
)(function* (database: Database, candidate: CorrectionSignalCandidate) {
  const input = yield* Schema.decodeUnknownEffect(CorrectionSignalCandidate)(candidate).pipe(
    decodingFailure("decode correction signal candidate"),
  );
  yield* validatePayload(
    "validate correction signal payload",
    input.signal_payload_json,
    input.signal_payload_digest,
  );
  const row = yield* Effect.try({
    try: () => {
      const drizzle = getDrizzleDb(database);
      return drizzle.transaction((transaction) => {
        const byId = transaction
          .select()
          .from(correction_signal_candidates)
          .where(eq(correction_signal_candidates.candidate_id, input.candidate_id))
          .get();
        const byKey = transaction
          .select()
          .from(correction_signal_candidates)
          .where(eq(correction_signal_candidates.idempotency_key, input.idempotency_key))
          .get();
        if (
          (byId && !candidateMatchesImmutable(byId, input)) ||
          (byKey && !candidateMatchesImmutable(byKey, input))
        ) {
          throw new CorrectionSignalStudyDraftConflict({
            operation: "upsert correction signal candidate",
            message: "The correction signal identifier is already bound to immutable evidence.",
          });
        }
        transaction.insert(correction_signal_candidates).values(input).onConflictDoNothing().run();
        transaction
          .update(correction_signal_candidates)
          .set({ lifecycle: input.lifecycle, reason: input.reason, updated_at: input.updated_at })
          .where(eq(correction_signal_candidates.candidate_id, input.candidate_id))
          .run();
        const persisted = transaction
          .select()
          .from(correction_signal_candidates)
          .where(eq(correction_signal_candidates.candidate_id, input.candidate_id))
          .get();
        if (!persisted || !candidateMatchesImmutable(persisted, input)) {
          throw new CorrectionSignalStudyDraftConflict({
            operation: "upsert correction signal candidate",
            message: "A concurrent correction signal write conflicted with immutable evidence.",
          });
        }
        return persisted;
      });
    },
    catch: (cause) => failure("upsert correction signal candidate", cause),
  });
  return yield* Schema.decodeUnknownEffect(CorrectionSignalCandidate)(row).pipe(
    decodingFailure("decode persisted correction signal candidate"),
  );
});

/** Upserts one bounded review draft for an existing E0/E0.5 signal candidate. */
export const upsertCorrectionStudyDraft = Effect.fn("LocalStore.upsertCorrectionStudyDraft")(
  function* (database: Database, draft: CorrectionStudyDraft) {
    const input = yield* Schema.decodeUnknownEffect(CorrectionStudyDraft)(draft).pipe(
      decodingFailure("decode correction study draft"),
    );
    yield* validatePayload(
      "validate correction study draft payload",
      input.study_payload_json,
      input.study_payload_digest,
    );
    const row = yield* Effect.try({
      try: () => {
        const drizzle = getDrizzleDb(database);
        return drizzle.transaction((transaction) => {
          const candidate = transaction
            .select()
            .from(correction_signal_candidates)
            .where(eq(correction_signal_candidates.candidate_id, input.candidate_id))
            .get();
          if (
            !candidate ||
            candidate.skill_id !== input.skill_id ||
            candidate.skill_name !== input.skill_name
          ) {
            throw new CorrectionSignalStudyDraftFailure({
              operation: "upsert correction study draft",
              message: "A StudyDraft requires an existing signal candidate for the same skill.",
            });
          }
          const byId = transaction
            .select()
            .from(correction_study_drafts)
            .where(eq(correction_study_drafts.draft_id, input.draft_id))
            .get();
          const byKey = transaction
            .select()
            .from(correction_study_drafts)
            .where(eq(correction_study_drafts.idempotency_key, input.idempotency_key))
            .get();
          const byCandidate = transaction
            .select()
            .from(correction_study_drafts)
            .where(eq(correction_study_drafts.candidate_id, input.candidate_id))
            .get();
          if (
            (byId && !draftMatchesImmutable(byId, input)) ||
            (byKey && !draftMatchesImmutable(byKey, input)) ||
            (byCandidate && !draftMatchesImmutable(byCandidate, input))
          ) {
            throw new CorrectionSignalStudyDraftConflict({
              operation: "upsert correction study draft",
              message:
                "The StudyDraft identifier is already bound to immutable preparation evidence.",
            });
          }
          transaction.insert(correction_study_drafts).values(input).onConflictDoNothing().run();
          transaction
            .update(correction_study_drafts)
            .set({ lifecycle: input.lifecycle, reason: input.reason, updated_at: input.updated_at })
            .where(eq(correction_study_drafts.draft_id, input.draft_id))
            .run();
          const persisted = transaction
            .select()
            .from(correction_study_drafts)
            .where(eq(correction_study_drafts.draft_id, input.draft_id))
            .get();
          if (!persisted || !draftMatchesImmutable(persisted, input)) {
            throw new CorrectionSignalStudyDraftConflict({
              operation: "upsert correction study draft",
              message:
                "A concurrent StudyDraft write conflicted with immutable preparation evidence.",
            });
          }
          return persisted;
        });
      },
      catch: (cause) => failure("upsert correction study draft", cause),
    });
    return yield* Schema.decodeUnknownEffect(CorrectionStudyDraft)(row).pipe(
      decodingFailure("decode persisted correction study draft"),
    );
  },
);
