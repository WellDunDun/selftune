import { Effect, Option, Schema } from "effect";
import { optionalEvidence, TranscriptToolInput } from "@selftune/runtime/utils/transcript-contract";

const Text = optionalEvidence(Schema.String);
const Header = Schema.Struct({
  type: Schema.Literal("session"),
  id: Text,
  timestamp: Text,
  cwd: Text,
  sessionKey: Text,
  session_key: Text,
  channel: Text,
  agentId: Text,
  agent_id: Text,
});
const ContentBlock = Schema.Struct({
  type: Text,
  name: Text,
  text: Text,
  input: optionalEvidence(TranscriptToolInput),
  isError: optionalEvidence(Schema.Boolean),
  is_error: optionalEvidence(Schema.Boolean),
});
const Content = Schema.Union([
  Schema.String,
  ContentBlock,
  Schema.Array(
    Schema.NullOr(ContentBlock).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null)))),
  ),
]);
const Message = Schema.Struct({
  role: Text,
  content: optionalEvidence(Content),
  isError: optionalEvidence(Schema.Boolean),
});

export const decodeOpenClawHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));
export const decodeOpenClawMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

export function openClawContentBlocks(content: typeof Content.Type | undefined) {
  if (content === undefined) return [];
  if (Schema.is(Schema.String)(content)) return [{ type: "text", text: content }];
  if (Schema.is(ContentBlock)(content)) return [content];
  return content.filter((block) => block !== null);
}
