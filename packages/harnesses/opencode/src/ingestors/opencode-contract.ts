import type { SQLQueryBindings } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { optionalEvidence } from "@selftune/runtime/utils/transcript-contract";

export type OpenCodeSourceRow = Record<string, SQLQueryBindings>;
export type OpenCodeSourceCell = SQLQueryBindings | Schema.Json | undefined;
const Text = optionalEvidence(Schema.String);
const NumberField = optionalEvidence(Schema.Number.check(Schema.isFinite()));
const Time = Schema.Struct({
  updated: NumberField,
  updatedAt: NumberField,
  created: NumberField,
  createdAt: NumberField,
});
const Usage = Schema.Struct({
  input_tokens: NumberField,
  input: NumberField,
  prompt_tokens: NumberField,
  output_tokens: NumberField,
  output: NumberField,
  completion_tokens: NumberField,
});

const ContentBlock = Schema.Struct({
  type: Text,
  text: Text,
  name: Text,
  input: optionalEvidence(Schema.Struct({ command: Text, cmd: Text, file_path: Text, path: Text })),
  error: optionalEvidence(Schema.Json),
  is_error: optionalEvidence(Schema.Json),
  tool_calls: optionalEvidence(
    Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          function: optionalEvidence(Schema.Struct({ name: Text })),
        }),
      ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null)))),
    ),
  ),
});
export type OpenCodeContentBlock = typeof ContentBlock.Type;
const Message = Schema.Struct({
  role: Text,
  content: optionalEvidence(Schema.Json),
  error: optionalEvidence(Schema.Json),
  time: optionalEvidence(Time),
  usage: optionalEvidence(Usage),
  tokens: optionalEvidence(Usage),
  provider: optionalEvidence(Schema.Json),
  providerID: Text,
  provider_id: Text,
  model: Text,
  modelID: Text,
  model_id: Text,
  updated: NumberField,
  updatedAt: NumberField,
  created: NumberField,
  createdAt: NumberField,
  summary: optionalEvidence(Schema.Struct({ title: Text })),
  path: optionalEvidence(Schema.Struct({ cwd: Text })),
});
export type OpenCodeMessage = typeof Message.Type;
const Session = Schema.Struct({
  ...Message.fields,
  id: Text,
  ended_at: NumberField,
  endedAt: NumberField,
  messages: optionalEvidence(
    Schema.Array(
      Schema.NullOr(Message).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null)))),
    ),
  ),
});

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));
const decodeText = Schema.decodeUnknownOption(Schema.String);
const decodeNumber = Schema.decodeUnknownOption(Schema.Number.check(Schema.isFinite()));
const decodeBlock = Schema.decodeUnknownOption(ContentBlock);
const decodeMessage = Schema.decodeUnknownOption(Message);
const decodeProvider = Schema.decodeUnknownOption(Schema.Struct({ id: Text, name: Text }));
export const decodeOpenCodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(Session));

export function sourceText(...values: ReadonlyArray<OpenCodeSourceCell>): string | undefined {
  for (const value of values) {
    const text = Option.getOrUndefined(decodeText(value))?.trim();
    if (text) return text;
  }
  return undefined;
}

export function sourceCount(...values: ReadonlyArray<OpenCodeSourceCell>): number | undefined {
  for (const value of values) {
    const count = Option.getOrUndefined(decodeNumber(value));
    if (count !== undefined && count >= 0) return Math.trunc(count);
  }
  return undefined;
}

export function sourceNumber(value: OpenCodeSourceCell): number | undefined {
  return Option.getOrUndefined(decodeNumber(value));
}

export function sourceProvider(value: Schema.Json | undefined) {
  return Option.getOrUndefined(decodeProvider(value));
}

export function decodeMessageContent(input: OpenCodeSourceCell): OpenCodeContentBlock[] {
  const value = Option.getOrElse(decodeJsonText(input), () => input);
  const text = decodeText(value);
  if (Option.isSome(text)) return [{ type: "text", text: text.value }];
  const array = decodeJsonArray(value);
  if (Option.isSome(array)) {
    return array.value.flatMap((item) => {
      const block = decodeBlock(item);
      return Option.isSome(block) ? [block.value] : [];
    });
  }
  const block = decodeBlock(value);
  return Option.isSome(block) ? [block.value] : [];
}

export function parseOpenCodeMessage(input: OpenCodeSourceCell): OpenCodeMessage | null {
  return Option.getOrNull(decodeMessage(Option.getOrElse(decodeJsonText(input), () => input)));
}
