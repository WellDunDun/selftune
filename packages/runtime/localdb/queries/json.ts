import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const decodeStrings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.mutable(Schema.Array(Schema.String))),
);
const decodeObjects = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.mutable(Schema.Array(JsonObject))),
);
const decodeCounts = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
);

export function safeParseJsonArray(json: string | null): string[] {
  return Option.getOrElse(decodeStrings(json), () => []);
}

export function safeParseJson(json: string | null) {
  return Option.getOrNull(decodeObject(json));
}

export function safeParseJsonObjectArray(json: string | null) {
  return Option.getOrElse(decodeObjects(json), () => []);
}

export function safeParseToolCounts(json: string | null) {
  return Option.getOrElse(decodeCounts(json), () => ({}));
}
