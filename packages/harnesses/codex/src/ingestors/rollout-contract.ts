import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { optionalEvidence } from "@selftune/runtime/utils/transcript-contract";

const Text = optionalEvidence(Schema.String);
const Count = optionalEvidence(
  Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
);
const Tokens = Schema.Struct({
  input_tokens: Count,
  output_tokens: Count,
  input: Count,
  output: Count,
});
const ContentPart = Schema.NullOr(Schema.Struct({ text: Text })).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
);
const Payload = Schema.Struct({
  type: Text,
  text: Text,
  id: Text,
  cwd: Text,
  model_provider: Text,
  model: Text,
  originator: Text,
  instructions: Text,
  base_instructions: optionalEvidence(Schema.Struct({ text: Text })),
  approval_policy: Text,
  sandbox_policy: Text,
  git: optionalEvidence(Schema.Struct({ branch: Text, remote: Text, commit: Text, sha: Text })),
  message: Text,
  token_count: optionalEvidence(Tokens),
  name: Text,
  arguments: Text,
  input: Text,
  role: Text,
  content: optionalEvidence(Schema.Array(ContentPart)),
});

export const decodeRolloutLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Text,
      thread_id: Text,
      timestamp: Text,
      prompt: Text,
      user_message: Text,
      payload: optionalEvidence(Payload),
      usage: optionalEvidence(Tokens),
      item: optionalEvidence(
        Schema.Struct({
          item_type: Text,
          type: Text,
          command: Text,
          tool: Text,
          text: Text,
          // Retain malformed statuses: only numeric zero proves success.
          exit_code: optionalEvidence(Schema.Json),
        }),
      ),
    }),
  ),
);
