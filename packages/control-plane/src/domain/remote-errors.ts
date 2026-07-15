import * as Schema from "effect/Schema";

export class RemoteIntegrityFailure extends Schema.TaggedErrorClass<RemoteIntegrityFailure>()(
  "RemoteIntegrityFailure",
  {
    expectedHash: Schema.String,
    actualHash: Schema.String,
  },
) {}

export class RemoteConflict extends Schema.TaggedErrorClass<RemoteConflict>()("RemoteConflict", {
  expectedParentId: Schema.NullOr(Schema.String),
  actualParentId: Schema.NullOr(Schema.String),
}) {}

export class RemoteObjectMissing extends Schema.TaggedErrorClass<RemoteObjectMissing>()(
  "RemoteObjectMissing",
  { objectHash: Schema.String },
) {}

export class RemoteLibraryUnavailable extends Schema.TaggedErrorClass<RemoteLibraryUnavailable>()(
  "RemoteLibraryUnavailable",
  { operation: Schema.String, message: Schema.String },
) {}
