import * as Schema from "effect/Schema";
import { stripMarkdownFences } from "../utils/llm-call.js";

export function decodeProposalResponse<A extends { readonly confidence: number }>(
  raw: string,
  schema: Schema.Codec<A>,
) {
  const { confidence, ...fields } = Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
    stripMarkdownFences(raw),
  );
  return { ...fields, confidence: Math.max(0, Math.min(1, confidence)) };
}
