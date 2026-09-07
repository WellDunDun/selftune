import { Option, Schema } from "effect";

export const CliJsonOutput = Schema.Record(Schema.String, Schema.Json);
export type CliJsonOutput = typeof CliJsonOutput.Type;
const decodeJsonOutput = Schema.decodeUnknownOption(Schema.fromJsonString(CliJsonOutput));

export function extractJsonObject(text: string): CliJsonOutput | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  return Option.getOrNull(decodeJsonOutput(trimmed));
}
