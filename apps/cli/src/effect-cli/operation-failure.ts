import * as Schema from "effect/Schema";

/** Fields the CLI consumes from failures returned by lazy-loaded local programs. */
export const OperationFailure = Schema.Struct({
  operation: Schema.String,
  message: Schema.String,
});
