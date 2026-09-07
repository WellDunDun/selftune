import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { optionalEvidence } from "@selftune/runtime/utils/transcript-contract";

const Text = optionalEvidence(Schema.String);
const Count = optionalEvidence(
  Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
);
const ToolInput = Schema.Struct({
  command: Text,
  cmd: Text,
  file_path: Text,
  filePath: Text,
  path: Text,
});
const Block = Schema.Struct({
  type: Text,
  text: Text,
  name: Text,
  arguments: optionalEvidence(ToolInput),
  input: optionalEvidence(ToolInput),
  isError: optionalEvidence(Schema.Boolean),
  is_error: optionalEvidence(Schema.Boolean),
});
const NullableBlock = Schema.NullOr(Block).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
);
const Content = Schema.Union([Schema.String, Schema.mutable(Schema.Array(NullableBlock)), Block]);
const Message = Schema.Struct({
  role: Schema.String,
  content: optionalEvidence(Content),
  provider: Text,
  model: Text,
  stopReason: Text,
  isError: optionalEvidence(Schema.Boolean),
  usage: optionalEvidence(Schema.Struct({ input: Count, output: Count })),
});
const Entry = Schema.Struct({
  type: Schema.String,
  id: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  timestamp: Text,
  provider: Text,
  modelId: Text,
  message: optionalEvidence(Message),
});
export type PiEntry = typeof Entry.Type;
export const decodePiEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Entry));
export const decodePiHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("session"),
      id: Text,
      timestamp: Text,
      cwd: Text,
    }),
  ),
);

export function normalizeContentBlocks(
  content: typeof Content.Type | undefined,
): ReadonlyArray<typeof Block.Type> {
  if (content === undefined) return [];
  if (Array.isArray(content)) return content.filter((block) => block !== null);
  return Match.value(content).pipe(
    Match.when(Match.string, (text) => [{ type: "text", text }]),
    Match.orElse((block) => [block]),
  );
}
