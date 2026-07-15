import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PushPayloadV2 } from "@selftune/telemetry-contract/types";

import { findSelftunePackageRoot } from "./package-root.js";
import type { CanonicalRecord, EvolutionEvidenceEntry } from "./types.js";

function getClientVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(findSelftunePackageRoot(), "package.json"), "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
      return "unknown";
    }
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function addOptional(record: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) {
    record[key] = value;
  }
}

export function buildPushPayloadV2(
  records: CanonicalRecord[],
  evidenceEntries: EvolutionEvidenceEntry[] = [],
  orchestrateRuns: Record<string, unknown>[] = [],
  gradingResults: Record<string, unknown>[] = [],
  improvementSignals: Record<string, unknown>[] = [],
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
    const record: Record<string, unknown> = {
      evidence_id: entry.evidence_id,
      skill_name: entry.skill_name,
      target: entry.target,
      stage: entry.stage,
    };
    addOptional(record, "timestamp", entry.timestamp);
    addOptional(record, "skill_path", entry.skill_path);
    addOptional(record, "proposal_id", entry.proposal_id);
    addOptional(record, "rationale", entry.rationale);
    addOptional(record, "confidence", entry.confidence);
    addOptional(record, "details", entry.details);
    addOptional(record, "original_text", entry.original_text);
    addOptional(record, "proposed_text", entry.proposed_text);
    addOptional(record, "eval_set_json", entry.eval_set);
    addOptional(record, "validation_json", entry.validation);
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
      evolution_evidence:
        evolutionEvidence as unknown as PushPayloadV2["canonical"]["evolution_evidence"],
      orchestrate_runs:
        orchestrateRuns as unknown as PushPayloadV2["canonical"]["orchestrate_runs"],
      grading_results: gradingResults as unknown as PushPayloadV2["canonical"]["grading_results"],
      improvement_signals:
        improvementSignals as unknown as PushPayloadV2["canonical"]["improvement_signals"],
    },
  };
}
