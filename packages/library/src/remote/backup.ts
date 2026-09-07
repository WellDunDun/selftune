import { RemoteSnapshot } from "@selftune/control-plane";
import { Schema } from "effect";

export const RemoteLibraryBackup = Schema.Struct({
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  headSnapshotId: Schema.NullOr(Schema.String),
  snapshots: Schema.Array(RemoteSnapshot),
  objects: Schema.Array(Schema.Struct({ objectHash: Schema.String, contentBase64: Schema.String })),
});
