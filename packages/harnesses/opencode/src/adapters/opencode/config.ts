import * as Schema from "effect/Schema";

export const OpenCodeAgentConfig = Schema.StructWithRest(
  Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    mode: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.mutableKey(Schema.String)),
    prompt: Schema.optionalKey(Schema.String),
    tools: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type OpenCodeAgentConfig = typeof OpenCodeAgentConfig.Type;

export const OpenCodeConfig = Schema.StructWithRest(
  Schema.Struct({
    agent: Schema.optionalKey(
      Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(OpenCodeAgentConfig))),
    ),
    plugin: Schema.optionalKey(Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String)))),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type OpenCodeConfig = typeof OpenCodeConfig.Type;
