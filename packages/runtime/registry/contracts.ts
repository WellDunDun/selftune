import { Schema } from "effect";

export const RegistryLookupResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
    }),
  ),
});

export const RegistryInstallLookupResponse = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

export const RegistryListResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.String,
      entry_type: Schema.String,
      description: Schema.NullOr(Schema.String),
      current_version: Schema.NullOr(
        Schema.Struct({
          version: Schema.String,
        }),
      ),
      pass_rate: Schema.NullOr(Schema.Number),
      eval_count: Schema.Number,
    }),
  ),
});

export const RegistryDetailResponse = Schema.Struct({
  entry: Schema.Struct({ id: Schema.String, name: Schema.String }),
  versions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      content_hash: Schema.String,
      is_current: Schema.Boolean,
    }),
  ),
});

export const RegistryStatusResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      entry_id: Schema.String,
      name: Schema.String,
      has_update: Schema.Boolean,
      latest_version: Schema.String,
      current_version: Schema.String,
      latest_content_hash: Schema.optionalKey(Schema.String),
      download_url: Schema.optionalKey(Schema.String),
    }),
  ),
});

export const RegistrySyncResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      entry_id: Schema.String,
      name: Schema.String,
      has_update: Schema.Boolean,
      latest_version: Schema.String,
      latest_content_hash: Schema.String,
      current_version: Schema.optionalKey(Schema.String),
      download_url: Schema.optionalKey(Schema.String),
    }),
  ),
});

export const RegistryInstallSyncResponse = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      download_url: Schema.optionalKey(Schema.String),
      latest_version: Schema.String,
      latest_content_hash: Schema.String,
    }),
  ),
});

export const RegistryHistoryResponse = Schema.Struct({
  versions: Schema.Array(
    Schema.Struct({
      version: Schema.String,
      is_current: Schema.Boolean,
      rolled_back: Schema.Boolean,
      aggregate_pass_rate: Schema.NullOr(Schema.Number),
      aggregate_sessions: Schema.Number,
      change_summary: Schema.NullOr(Schema.String),
      pushed_at: Schema.String,
    }),
  ),
});

export const RegistryMutationResponse = Schema.Record(Schema.String, Schema.Unknown);
export const EmptyRegistryResponse = Schema.Record(Schema.String, Schema.Unknown);
