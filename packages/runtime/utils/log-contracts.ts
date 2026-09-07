import * as Schema from "effect/Schema";
import { OrchestrateRunReport } from "@selftune/control-plane/orchestration";
import { isCanonicalRecord } from "@selftune/telemetry-contract";
import { EvalEntry } from "../types/evaluation.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  EvolutionEvidenceValidation,
  ImprovementSignalRecord,
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { optionalEvidence } from "./transcript-contract.js";
import { jsonlDecoder } from "./jsonl.js";

const Text = optionalEvidence(Schema.String);
const NumberEvidence = optionalEvidence(Schema.Number);
const StringList = Schema.mutable(Schema.Array(Schema.String));
const ValidationMode = Schema.Literals(["structural_guard", "host_replay", "llm_judge"]);

const QueryLog: Schema.Codec<QueryLogRecord> = Schema.Struct({
  timestamp: Schema.String,
  session_id: Schema.String,
  query: Schema.String,
  source: Text,
});

const SkillUsageLog: Schema.Codec<SkillUsageRecord> = Schema.Struct({
  timestamp: Schema.String,
  session_id: Schema.String,
  skill_name: Schema.String,
  skill_path: Schema.String,
  query: Schema.String,
  triggered: Schema.Boolean,
  skill_version_hash: Text,
  skill_scope: optionalEvidence(
    Schema.Literals(["project", "global", "admin", "system", "unknown"]),
  ),
  skill_project_root: Text,
  skill_registry_dir: Text,
  skill_path_resolution_source: optionalEvidence(
    Schema.Literals(["raw_log", "installed_scope", "launcher_base_dir", "fallback"]),
  ),
  invocation_type: optionalEvidence(
    Schema.Literals(["explicit", "implicit", "inferred", "contextual"]),
  ),
  source: Text,
});

const SessionTelemetryLog: Schema.Codec<SessionTelemetryRecord> = Schema.Struct({
  timestamp: Schema.String,
  session_id: Schema.String,
  cwd: Schema.String,
  transcript_path: Schema.String,
  tool_calls: Schema.Record(Schema.String, Schema.Number),
  total_tool_calls: Schema.Number,
  bash_commands: StringList,
  skills_triggered: StringList,
  skills_invoked: optionalEvidence(StringList),
  assistant_turns: Schema.Number,
  errors_encountered: Schema.Number,
  transcript_chars: Schema.Number,
  last_user_query: Schema.String,
  source: Text,
  input_tokens: NumberEvidence,
  output_tokens: NumberEvidence,
  cached_input_tokens: NumberEvidence,
  reasoning_output_tokens: NumberEvidence,
  cost_usd: NumberEvidence,
  files_changed: NumberEvidence,
  lines_added: NumberEvidence,
  lines_removed: NumberEvidence,
  lines_modified: NumberEvidence,
  artifact_count: NumberEvidence,
  session_type: optionalEvidence(Schema.Literals(["dev", "research", "content", "mixed"])),
  agent_summary: Text,
  rollout_path: Text,
  duration_ms: NumberEvidence,
});

const ImprovementSignalLog: Schema.Codec<ImprovementSignalRecord> = Schema.Struct({
  timestamp: Schema.String,
  session_id: Schema.String,
  query: Schema.String,
  signal_type: Schema.Literals(["correction", "explicit_request", "manual_invocation"]),
  mentioned_skill: Text,
  consumed: Schema.Boolean,
  consumed_at: Text,
  consumed_by_run: Text,
});

const EvolutionAuditLog: Schema.Codec<EvolutionAuditEntry> = Schema.Struct({
  timestamp: Schema.String,
  proposal_id: Schema.String,
  skill_name: Text,
  action: Schema.Literals(["created", "validated", "deployed", "rolled_back", "rejected"]),
  details: Schema.String,
  eval_snapshot: optionalEvidence(
    Schema.Struct({
      total: Schema.Number,
      passed: Schema.Number,
      failed: Schema.Number,
      pass_rate: Schema.Number,
    }),
  ),
  iterations_used: NumberEvidence,
  validation_mode: optionalEvidence(ValidationMode),
  validation_agent: Text,
  validation_fixture_id: Text,
  validation_evidence_ref: Text,
});

const EntryResults = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      entry: EvalEntry,
      before_pass: Schema.Boolean,
      after_pass: Schema.Boolean,
    }),
  ),
);
const EvolutionValidation: Schema.Codec<EvolutionEvidenceValidation> = Schema.Struct({
  improved: optionalEvidence(Schema.Boolean),
  before_pass_rate: NumberEvidence,
  after_pass_rate: NumberEvidence,
  net_change: NumberEvidence,
  regressions: optionalEvidence(
    Schema.Union([Schema.mutable(Schema.Array(EvalEntry)), StringList]),
  ),
  new_passes: optionalEvidence(Schema.mutable(Schema.Array(EvalEntry))),
  per_entry_results: optionalEvidence(EntryResults),
  before_entry_results: optionalEvidence(EntryResults),
  gates_passed: NumberEvidence,
  gates_total: NumberEvidence,
  gate_results: optionalEvidence(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          gate: Schema.Literals(["structural", "trigger_accuracy", "quality"]),
          passed: Schema.Boolean,
          reason: Schema.String,
        }),
      ),
    ),
  ),
  validation_mode: optionalEvidence(ValidationMode),
  validation_agent: Text,
  validation_fixture_id: Text,
  validation_fallback_reason: Text,
  validation_evidence_ref: Text,
});

const EvolutionEvidenceLog: Schema.Codec<EvolutionEvidenceEntry> = Schema.Struct({
  timestamp: Schema.String,
  proposal_id: Schema.String,
  skill_name: Schema.String,
  skill_path: Schema.String,
  target: Schema.Literals(["description", "routing", "body", "new_skill"]),
  stage: Schema.Literals([
    "proposed",
    "created",
    "validated",
    "deployed",
    "rejected",
    "rolled_back",
  ]),
  rationale: Text,
  confidence: NumberEvidence,
  details: Text,
  original_text: Text,
  proposed_text: Text,
  eval_set: optionalEvidence(Schema.mutable(Schema.Array(EvalEntry))),
  validation: optionalEvidence(EvolutionValidation),
  evidence_id: Text,
});

// Preserve forward-compatible local evidence fields; declared fields still decode.
export const decodeQueryLogLine = jsonlDecoder(QueryLog);
export const decodeSkillUsageLine = jsonlDecoder(SkillUsageLog);
export const decodeSessionTelemetryLine = jsonlDecoder(SessionTelemetryLog);
export const decodeImprovementSignalLine = jsonlDecoder(ImprovementSignalLog);
export const decodeImprovementSignalRecord = Schema.decodeUnknownOption(ImprovementSignalLog);
export const decodeEvolutionAuditLine = jsonlDecoder(EvolutionAuditLog);
export const decodeEvolutionEvidenceLine = jsonlDecoder(EvolutionEvidenceLog);
export const decodeEvolutionAuditRecord = Schema.decodeUnknownOption(EvolutionAuditLog);
export const decodeEvolutionEvidenceRecord = Schema.decodeUnknownOption(EvolutionEvidenceLog);
export const decodeOrchestrateRunLine = jsonlDecoder(OrchestrateRunReport);
export const decodeLogTimestampLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ timestamp: Schema.String })),
);

export function decodeCanonicalLogLine(line: string) {
  const value: unknown = JSON.parse(line);
  if (!isCanonicalRecord(value)) throw new TypeError("Invalid canonical log record");
  return value;
}
