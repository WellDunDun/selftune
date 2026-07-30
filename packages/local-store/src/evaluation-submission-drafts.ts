/**
 * Durable local lifecycle for a Cloud evaluation prepared from local traces.
 *
 * This repository intentionally treats payload_json as opaque JSON. Its
 * portable contract is owned and decoded by the runtime at submission time;
 * SQLite owns only the idempotent local hand-off lifecycle.
 */
import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getDrizzleDb } from "./db.js";
import { evaluation_submission_drafts } from "./drizzle-schema.js";

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const CohortFingerprint = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const SkillName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const SkillRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Timestamp = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const PayloadJson = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536));

export const EvaluationSubmissionDraftLifecycle = Schema.Literals([
  "prepared",
  "submitted",
  "stale",
] as const);

export class EvaluationSubmissionDraft extends Schema.Class<EvaluationSubmissionDraft>(
  "EvaluationSubmissionDraft",
)({
  draft_id: Identifier,
  pattern_id: Identifier,
  cohort_fingerprint: CohortFingerprint,
  skill_name: SkillName,
  skill_revision: SkillRevision,
  payload_json: PayloadJson,
  lifecycle: EvaluationSubmissionDraftLifecycle,
  cloud_run_id: Schema.NullOr(Identifier),
  created_at: Timestamp,
  updated_at: Timestamp,
}) {}

export class PrepareEvaluationSubmissionDraft extends Schema.Class<PrepareEvaluationSubmissionDraft>(
  "PrepareEvaluationSubmissionDraft",
)({
  draft_id: Identifier,
  pattern_id: Identifier,
  cohort_fingerprint: CohortFingerprint,
  skill_name: SkillName,
  skill_revision: SkillRevision,
  payload_json: PayloadJson,
  prepared_at: Schema.optionalKey(Timestamp),
}) {}

export class MarkEvaluationSubmissionDraftSubmitted extends Schema.Class<MarkEvaluationSubmissionDraftSubmitted>(
  "MarkEvaluationSubmissionDraftSubmitted",
)({
  draft_id: Identifier,
  cloud_run_id: Identifier,
  submitted_at: Schema.optionalKey(Timestamp),
}) {}

export class MarkEvaluationSubmissionDraftStale extends Schema.Class<MarkEvaluationSubmissionDraftStale>(
  "MarkEvaluationSubmissionDraftStale",
)({
  draft_id: Identifier,
  stale_at: Schema.optionalKey(Timestamp),
}) {}

export class EvaluationSubmissionDraftFailure extends Schema.TaggedErrorClass<EvaluationSubmissionDraftFailure>()(
  "EvaluationSubmissionDraftFailure",
  { operation: Schema.String, message: Schema.String },
) {}

function failure(operation: string, cause: unknown): EvaluationSubmissionDraftFailure {
  return new EvaluationSubmissionDraftFailure({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function decodeDraft(
  operation: string,
  value: unknown,
): Effect.Effect<EvaluationSubmissionDraft, EvaluationSubmissionDraftFailure> {
  return Schema.decodeUnknownEffect(EvaluationSubmissionDraft)(value).pipe(
    Effect.mapError(
      (error) => new EvaluationSubmissionDraftFailure({ operation, message: error.message }),
    ),
  );
}

function validateOpaqueJson(
  payloadJson: string,
): Effect.Effect<void, EvaluationSubmissionDraftFailure> {
  return Effect.try({
    try: () => {
      JSON.parse(payloadJson);
    },
    catch: (cause) => failure("validate evaluation submission draft payload", cause),
  });
}

/**
 * Inserts a content-addressed prepared draft. Repeating the exact candidate
 * refreshes only that unsubmitted draft; a different candidate for the same
 * cohort receives a different draft id. Submitted and stale drafts are
 * immutable historical receipts.
 */
export const createOrGetPreparedEvaluationSubmissionDraft = Effect.fn(
  "LocalStore.createOrGetPreparedEvaluationSubmissionDraft",
)(function* (database: Database, unknown: unknown) {
  const input = yield* Schema.decodeUnknownEffect(PrepareEvaluationSubmissionDraft)(unknown).pipe(
    Effect.mapError(
      (error) =>
        new EvaluationSubmissionDraftFailure({
          operation: "decode prepared evaluation submission draft",
          message: error.message,
        }),
    ),
  );
  yield* validateOpaqueJson(input.payload_json);
  const preparedAt = input.prepared_at ?? new Date().toISOString();

  const row = yield* Effect.try({
    try: () => {
      const drizzle = getDrizzleDb(database);
      drizzle.transaction((transaction) => {
        transaction
          .insert(evaluation_submission_drafts)
          .values({
            draft_id: input.draft_id,
            pattern_id: input.pattern_id,
            cohort_fingerprint: input.cohort_fingerprint,
            skill_name: input.skill_name,
            skill_revision: input.skill_revision,
            payload_json: input.payload_json,
            lifecycle: "prepared",
            cloud_run_id: null,
            created_at: preparedAt,
            updated_at: preparedAt,
          })
          .onConflictDoNothing()
          .run();

        transaction
          .update(evaluation_submission_drafts)
          .set({ payload_json: input.payload_json, updated_at: preparedAt })
          .where(
            and(
              eq(evaluation_submission_drafts.draft_id, input.draft_id),
              eq(evaluation_submission_drafts.lifecycle, "prepared"),
            ),
          )
          .run();
      });

      return drizzle
        .select()
        .from(evaluation_submission_drafts)
        .where(eq(evaluation_submission_drafts.draft_id, input.draft_id))
        .get();
    },
    catch: (cause) => failure("create or get prepared evaluation submission draft", cause),
  });

  if (!row) {
    return yield* new EvaluationSubmissionDraftFailure({
      operation: "create or get prepared evaluation submission draft",
      message: "The evaluation submission draft was not found after persistence.",
    });
  }
  return yield* decodeDraft("decode persisted evaluation submission draft", row);
});

export const getEvaluationSubmissionDraft = Effect.fn("LocalStore.getEvaluationSubmissionDraft")(
  function* (database: Database, unknownDraftId: unknown) {
    const draftId = yield* Schema.decodeUnknownEffect(Identifier)(unknownDraftId).pipe(
      Effect.mapError(
        (error) =>
          new EvaluationSubmissionDraftFailure({
            operation: "decode evaluation submission draft id",
            message: error.message,
          }),
      ),
    );
    const row = yield* Effect.try({
      try: () =>
        getDrizzleDb(database)
          .select()
          .from(evaluation_submission_drafts)
          .where(eq(evaluation_submission_drafts.draft_id, draftId))
          .get(),
      catch: (cause) => failure("get evaluation submission draft", cause),
    });
    return row === undefined
      ? null
      : yield* decodeDraft("decode persisted evaluation submission draft", row);
  },
);

/** Marks only a prepared draft stale. Repeating the transition is idempotent. */
export const markEvaluationSubmissionDraftStale = Effect.fn(
  "LocalStore.markEvaluationSubmissionDraftStale",
)(function* (database: Database, unknown: unknown) {
  const input = yield* Schema.decodeUnknownEffect(MarkEvaluationSubmissionDraftStale)(unknown).pipe(
    Effect.mapError(
      (error) =>
        new EvaluationSubmissionDraftFailure({
          operation: "decode stale evaluation submission draft",
          message: error.message,
        }),
    ),
  );
  const staleAt = input.stale_at ?? new Date().toISOString();
  const row = yield* Effect.try({
    try: () => {
      const drizzle = getDrizzleDb(database);
      drizzle
        .update(evaluation_submission_drafts)
        .set({ lifecycle: "stale", updated_at: staleAt })
        .where(
          and(
            eq(evaluation_submission_drafts.draft_id, input.draft_id),
            eq(evaluation_submission_drafts.lifecycle, "prepared"),
          ),
        )
        .run();
      return drizzle
        .select()
        .from(evaluation_submission_drafts)
        .where(eq(evaluation_submission_drafts.draft_id, input.draft_id))
        .get();
    },
    catch: (cause) => failure("mark evaluation submission draft stale", cause),
  });
  if (!row) {
    return yield* new EvaluationSubmissionDraftFailure({
      operation: "mark evaluation submission draft stale",
      message: "The evaluation submission draft does not exist.",
    });
  }
  return yield* decodeDraft("decode persisted evaluation submission draft", row);
});

/**
 * Atomically records a Cloud receipt. A retry with the same receipt succeeds;
 * a different receipt can never replace the original one.
 */
export const markEvaluationSubmissionDraftSubmitted = Effect.fn(
  "LocalStore.markEvaluationSubmissionDraftSubmitted",
)(function* (database: Database, unknown: unknown) {
  const input = yield* Schema.decodeUnknownEffect(MarkEvaluationSubmissionDraftSubmitted)(
    unknown,
  ).pipe(
    Effect.mapError(
      (error) =>
        new EvaluationSubmissionDraftFailure({
          operation: "decode submitted evaluation submission draft",
          message: error.message,
        }),
    ),
  );
  const submittedAt = input.submitted_at ?? new Date().toISOString();
  const row = yield* Effect.try({
    try: () => {
      const drizzle = getDrizzleDb(database);
      return drizzle.transaction((transaction) => {
        transaction
          .update(evaluation_submission_drafts)
          .set({
            lifecycle: "submitted",
            cloud_run_id: input.cloud_run_id,
            updated_at: submittedAt,
          })
          .where(
            and(
              eq(evaluation_submission_drafts.draft_id, input.draft_id),
              eq(evaluation_submission_drafts.lifecycle, "prepared"),
              isNull(evaluation_submission_drafts.cloud_run_id),
            ),
          )
          .run();
        const draft = transaction
          .select()
          .from(evaluation_submission_drafts)
          .where(eq(evaluation_submission_drafts.draft_id, input.draft_id))
          .get();
        return draft;
      });
    },
    catch: (cause) => failure("mark evaluation submission draft submitted", cause),
  });
  if (!row) {
    return yield* new EvaluationSubmissionDraftFailure({
      operation: "mark evaluation submission draft submitted",
      message: "The evaluation submission draft does not exist.",
    });
  }
  const draft = yield* decodeDraft("decode persisted evaluation submission draft", row);
  if (draft.lifecycle === "submitted" && draft.cloud_run_id === input.cloud_run_id) {
    return draft;
  }
  return yield* new EvaluationSubmissionDraftFailure({
    operation: "mark evaluation submission draft submitted",
    message:
      draft.lifecycle === "stale"
        ? "A stale evaluation submission draft cannot be submitted."
        : "A different Cloud run receipt is already recorded for this evaluation submission draft.",
  });
});
