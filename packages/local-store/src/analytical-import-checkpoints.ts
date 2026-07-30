import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { analytical_import_checkpoints } from "./drizzle-schema.js";
import { getDrizzleDb } from "./db.js";

const NonEmptyText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512));

export class AnalyticalImportCheckpoint extends Schema.Class<AnalyticalImportCheckpoint>(
  "AnalyticalImportCheckpoint",
)({
  source_kind: NonEmptyText,
  source_identity: NonEmptyText,
  source_fingerprint: NonEmptyText,
  normalizer_version: NonEmptyText,
}) {}

export class AnalyticalImportCheckpointFailure extends Schema.TaggedErrorClass<AnalyticalImportCheckpointFailure>()(
  "AnalyticalImportCheckpointFailure",
  { operation: Schema.String, message: Schema.String },
) {}

export const isAnalyticalImportCurrent = Effect.fn("LocalStore.isAnalyticalImportCurrent")(
  function* (database: Database, checkpoint: AnalyticalImportCheckpoint) {
    return yield* Effect.try({
      try: () => {
        const row = getDrizzleDb(database)
          .select({
            source_fingerprint: analytical_import_checkpoints.source_fingerprint,
            normalizer_version: analytical_import_checkpoints.normalizer_version,
          })
          .from(analytical_import_checkpoints)
          .where(
            and(
              eq(analytical_import_checkpoints.source_kind, checkpoint.source_kind),
              eq(analytical_import_checkpoints.source_identity, checkpoint.source_identity),
            ),
          )
          .get();
        return (
          row?.source_fingerprint === checkpoint.source_fingerprint &&
          row.normalizer_version === checkpoint.normalizer_version
        );
      },
      catch: (cause) =>
        AnalyticalImportCheckpointFailure.make({
          operation: "read analytical import checkpoint",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  },
);

export const acknowledgeAnalyticalImport = Effect.fn("LocalStore.acknowledgeAnalyticalImport")(
  function* (
    database: Database,
    checkpoint: AnalyticalImportCheckpoint,
    importedAt: string = new Date().toISOString(),
  ) {
    return yield* Effect.try({
      try: () => {
        getDrizzleDb(database)
          .insert(analytical_import_checkpoints)
          .values({ ...checkpoint, imported_at: importedAt })
          .onConflictDoUpdate({
            target: [
              analytical_import_checkpoints.source_kind,
              analytical_import_checkpoints.source_identity,
            ],
            set: {
              source_fingerprint: checkpoint.source_fingerprint,
              normalizer_version: checkpoint.normalizer_version,
              imported_at: importedAt,
            },
          })
          .run();
      },
      catch: (cause) =>
        AnalyticalImportCheckpointFailure.make({
          operation: "acknowledge analytical import",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  },
);
