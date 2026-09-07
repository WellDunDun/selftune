import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  CanonicalEvolutionEvidenceRecord,
  PushPayloadV2,
} from "@selftune/telemetry-contract/types";

import { findSelftunePackageRoot } from "./package-root.js";
import type { CanonicalRecord, EvolutionEvidenceEntry } from "./types.js";

function getClientVersion(): string {
  try {
    return Option.match(
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
        readFileSync(join(findSelftunePackageRoot(), "package.json"), "utf-8"),
      ),
      { onNone: () => "unknown", onSome: (parsed) => parsed.version },
    );
  } catch {
    return "unknown";
  }
}

export function buildPushPayloadV2(
  records: CanonicalRecord[],
  evidenceEntries: EvolutionEvidenceEntry[] = [],
  orchestrateRuns: NonNullable<PushPayloadV2["canonical"]["orchestrate_runs"]> = [],
  gradingResults: NonNullable<PushPayloadV2["canonical"]["grading_results"]> = [],
  improvementSignals: NonNullable<PushPayloadV2["canonical"]["improvement_signals"]> = [],
): PushPayloadV2 {
  const sessions = records.filter(
    (record): record is Extract<CanonicalRecord, { record_kind: "session" }> =>
      record.record_kind === "session",
  );
  const prompts = records.filter(
    (record): record is Extract<CanonicalRecord, { record_kind: "prompt" }> =>
      record.record_kind === "prompt",
  );
  const skillInvocations = records.filter(
    (record): record is Extract<CanonicalRecord, { record_kind: "skill_invocation" }> =>
      record.record_kind === "skill_invocation",
  );
  const executionFacts = records.filter(
    (record): record is Extract<CanonicalRecord, { record_kind: "execution_fact" }> =>
      record.record_kind === "execution_fact",
  );
  const normalizationRuns = records.filter(
    (record): record is Extract<CanonicalRecord, { record_kind: "normalization_run" }> =>
      record.record_kind === "normalization_run",
  );
  const normalizerVersion = records[0]?.normalizer_version ?? "1.0.0";
  const evolutionEvidence = evidenceEntries.map((entry) => {
    const record: CanonicalEvolutionEvidenceRecord = {
      evidence_id: entry.evidence_id,
      skill_name: entry.skill_name,
      target: entry.target,
      stage: entry.stage,
    };
    if (entry.timestamp != null) record.timestamp = entry.timestamp;
    if (entry.skill_path != null) record.skill_path = entry.skill_path;
    if (entry.proposal_id != null) record.proposal_id = entry.proposal_id;
    if (entry.rationale != null) record.rationale = entry.rationale;
    if (entry.confidence != null) record.confidence = entry.confidence;
    if (entry.details != null) record.details = entry.details;
    if (entry.original_text != null) record.original_text = entry.original_text;
    if (entry.proposed_text != null) record.proposed_text = entry.proposed_text;
    if (entry.eval_set != null) record.eval_set_json = entry.eval_set;
    if (entry.validation != null) record.validation_json = entry.validation;
    return record;
  });

  return {
    schema_version: "2.0",
    client_version: getClientVersion(),
    push_id: randomUUID(),
    normalizer_version: normalizerVersion,
    canonical: {
      sessions,
      prompts,
      skill_invocations: skillInvocations,
      execution_facts: executionFacts,
      normalization_runs: normalizationRuns,
      evolution_evidence: evolutionEvidence,
      orchestrate_runs: orchestrateRuns,
      grading_results: gradingResults,
      improvement_signals: improvementSignals,
    },
  };
}
