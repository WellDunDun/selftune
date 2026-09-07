import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Optional evidence can be malformed in interrupted/older transcripts. Discard
// that field, not the valid events or measurements beside it.
export function optionalEvidence<S extends Schema.Top>(schema: S) {
  return Schema.catchDecoding<Schema.optionalKey<S>>(() => Effect.succeed(Option.none()))(
    Schema.optionalKey(schema),
  );
}

const Text = optionalEvidence(Schema.String);
const Count = optionalEvidence(
  Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
);
const Usage = Schema.Struct({
  input_tokens: Count,
  output_tokens: Count,
  cache_read_input_tokens: Count,
  cache_creation_input_tokens: Count,
  reasoning_output_tokens: Count,
});
export const TranscriptToolInput = Schema.Struct({
  file_path: Text,
  command: Text,
  cmd: Text,
  path: Text,
  query: Text,
  skill: Text,
  name: Text,
  content: Text,
  old_string: Text,
  new_string: Text,
});

const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Text,
  id: Text,
  name: Text,
  input: optionalEvidence(Schema.Record(Schema.String, Schema.Json)),
  is_error: optionalEvidence(Schema.Boolean),
});
const Content = Schema.Union([
  Schema.String,
  Schema.mutable(
    Schema.Array(
      Schema.NullOr(ContentBlock).pipe(
        Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
      ),
    ),
  ),
]);
export type TranscriptContent = typeof Content.Type;

const Message = Schema.Struct({
  role: Text,
  model: Text,
  timestamp: Text,
  content: optionalEvidence(Content),
  usage: optionalEvidence(Usage),
});
const TranscriptEntry = Schema.Struct({
  ...Message.fields,
  type: Text,
  is_error: optionalEvidence(Schema.Boolean),
  message: optionalEvidence(Message),
  user_message: optionalEvidence(Content),
  payload: optionalEvidence(
    Schema.Struct({
      type: Text,
      role: Text,
      name: Text,
      text: Text,
      arguments: Text,
      message: optionalEvidence(Content),
      content: optionalEvidence(Content),
    }),
  ),
  item: optionalEvidence(
    Schema.Struct({
      type: Text,
      item_type: Text,
      command: Text,
      text: Text,
    }),
  ),
});

export const decodeTranscriptLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(TranscriptEntry),
);
export type TranscriptEntry = typeof TranscriptEntry.Type;
export const decodeTranscriptArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(TranscriptToolInput),
);
export const decodeTranscriptToolInput = Schema.decodeUnknownSync(TranscriptToolInput);
