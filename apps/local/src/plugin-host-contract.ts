import * as Schema from "effect/Schema";
import { optionalEvidence } from "@selftune/runtime/utils/transcript-contract";

const Text = optionalEvidence(Schema.String);
export const ClaudePlugin = Schema.Struct({
  id: Schema.NonEmptyString,
  version: Text,
  scope: Text,
  enabled: optionalEvidence(Schema.Boolean),
});
export const CodexPlugin = Schema.Struct({
  pluginId: Schema.NonEmptyString,
  version: Text,
  marketplaceName: Text,
  enabled: optionalEvidence(Schema.Boolean),
  source: optionalEvidence(Schema.Struct({ source: Text })),
});
