import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { optionalEvidence } from "@selftune/runtime/utils/transcript-contract";

const Text = optionalEvidence(Schema.String);
const ResultPart = Schema.Union([Schema.String, Schema.Struct({ text: Text, content: Text })]);
const ResultContent = Schema.Union([
  Schema.String,
  Schema.mutable(
    Schema.Array(
      Schema.NullOr(ResultPart).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null)))),
    ),
  ),
]);
const Block = Schema.Struct({
  type: Text,
  text: Text,
  tool_use_id: Text,
  id: Text,
  name: Text,
  content: optionalEvidence(ResultContent),
  input: optionalEvidence(Schema.Struct({ file_path: Text, skill: Text, name: Text })),
});
const Content = Schema.Union([
  Schema.String,
  Schema.mutable(
    Schema.Array(
      Schema.NullOr(Block).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null)))),
    ),
  ),
]);
const Message = Schema.Struct({
  role: Text,
  timestamp: Text,
  cwd: Text,
  content: optionalEvidence(Content),
});
export type RepairContent = typeof Content.Type;
export const decodeRepairLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ...Message.fields,
      message: optionalEvidence(Message),
      data: optionalEvidence(Schema.Struct({ cwd: Text })),
    }),
  ),
);

export function repairContentBlocks(content: RepairContent | undefined) {
  return Array.isArray(content) ? content.filter((block) => block !== null) : [];
}

export function extractToolResultText(content: typeof ResultContent.Type | undefined): string {
  if (content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part === null
          ? ""
          : Match.value(part).pipe(
              Match.when(Match.string, (text) => text),
              Match.orElse((block) => block.text?.trim() || block.content?.trim() || ""),
            ),
      )
      .filter(Boolean)
      .join("\n");
  }
  return content;
}

export function actionableContentText(content: RepairContent | undefined): string {
  if (content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => (part?.type === "text" && part.text ? [part.text] : []))
      .join(" ")
      .trim();
  }
  return content.trim();
}

export const decodeSkillPathEvidence = Schema.decodeUnknownOption(
  Schema.Struct({ skill_name: Schema.String, skill_path: Schema.String }),
);
export const decodeQueryEvidence = Schema.decodeUnknownOption(
  Schema.Struct({ query: Schema.String }),
);
