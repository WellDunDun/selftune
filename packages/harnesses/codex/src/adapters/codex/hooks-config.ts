import * as Schema from "effect/Schema";

export const JsonFields = Schema.Record(Schema.String, Schema.mutableKey(Schema.Json));
export const CodexHookHandler = Schema.StructWithRest(
  Schema.Struct({
    command: Schema.mutableKey(Schema.optionalKey(Schema.String)),
    _selftune: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
  }),
  [JsonFields],
);
export type CodexHookHandler = typeof CodexHookHandler.Type;

export const CodexMatcherGroup = Schema.StructWithRest(
  Schema.Struct({
    hooks: Schema.mutable(Schema.Array(CodexHookHandler)),
  }),
  [JsonFields],
);
export type CodexMatcherGroup = typeof CodexMatcherGroup.Type;

export const CodexHooksByEvent = Schema.Record(
  Schema.String,
  Schema.mutableKey(Schema.mutable(Schema.Array(CodexMatcherGroup))),
);
export type CodexHooksByEvent = typeof CodexHooksByEvent.Type;

export const CodexHooksFile = Schema.StructWithRest(
  Schema.Struct({
    hooks: Schema.optionalKey(CodexHooksByEvent),
  }),
  [JsonFields],
);
