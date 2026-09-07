import * as Schema from "effect/Schema";
import { optionalEvidence } from "../utils/transcript-contract.js";

// Canonical records can carry local usage metadata beyond the portable contract.
// Decode it before binding SQL values; one malformed field must not lose a skill use.
export const decodeInvocationLocalFields = Schema.decodeUnknownSync(
  Schema.Struct({
    query: optionalEvidence(Schema.String),
    skill_path: optionalEvidence(Schema.String),
    skill_scope: optionalEvidence(Schema.String),
    source: optionalEvidence(Schema.String),
    tool_name: optionalEvidence(Schema.String),
    agent_type: optionalEvidence(Schema.String),
    skill_version_hash: optionalEvidence(Schema.String),
  }),
);
