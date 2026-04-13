/**
 * V2 canonical push payload builder (staging-based).
 *
 * Reads from the canonical_upload_staging table using a single monotonic
 * cursor (local_seq). Each staged row contains the full canonical record
 * JSON, so no fields are dropped or hardcoded during payload construction.
 *
 * Evolution evidence rows (record_kind = "evolution_evidence") are separated
 * and placed in the canonical.evolution_evidence array.
 */

import type { Database } from "bun:sqlite";

import type { CanonicalRecord, PushPayloadV2 } from "@selftune/telemetry-contract/types";

import { buildPushPayloadV2 } from "../canonical-export.js";
import type { EvolutionEvidenceEntry } from "../types.js";

// -- Types --------------------------------------------------------------------

export interface BuildV2Result {
  payload: PushPayloadV2 & { content_hashes?: Record<string, string> };
  lastSeq: number;
}

// -- Constants ----------------------------------------------------------------

const DEFAULT_LIMIT = 500;

// -- Helpers ------------------------------------------------------------------

/** Parse a JSON string, returning null on failure. */
function safeParseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// -- Main builder -------------------------------------------------------------

/**
 * Build a V2 canonical push payload from the staging table.
 *
 * Reads records from canonical_upload_staging WHERE local_seq > afterSeq,
 * groups them by record_kind, and assembles a V2 push payload.
 *
 * Returns null when no new records exist after afterSeq.
 */
export function buildV2PushPayload(
  db: Database,
  afterSeq?: number,
  limit: number = DEFAULT_LIMIT,
): BuildV2Result | null {
  const whereClause = afterSeq !== undefined ? "WHERE local_seq > ?" : "";
  const params = afterSeq !== undefined ? [afterSeq, limit] : [limit];

  const sql = `
    SELECT local_seq, record_kind, record_id, record_json, content_sha256
    FROM canonical_upload_staging
    ${whereClause}
    ORDER BY local_seq ASC
    LIMIT ?
  `;

  const rows = db.query(sql).all(...params) as Array<{
    local_seq: number;
    record_kind: string;
    record_id: string;
    record_json: string;
    content_sha256: string | null;
  }>;

  if (rows.length === 0) return null;

  const canonicalRecords: CanonicalRecord[] = [];
  const evidenceEntries: EvolutionEvidenceEntry[] = [];
  const orchestrateRuns: Record<string, unknown>[] = [];
  const gradingResults: Record<string, unknown>[] = [];
  const improvementSignals: Record<string, unknown>[] = [];
  const contentHashes: Record<string, string> = {};
  let lastParsedSeq: number | null = null;
  let hitMalformedRow = false;

  for (const row of rows) {
    const parsed = safeParseJson<Record<string, unknown>>(row.record_json);
    if (!parsed) {
      hitMalformedRow = true;
      break;
    }
    // Collect content hashes for dedup — only after successful parse, keyed by kind:id
    if (row.content_sha256) {
      contentHashes[`${row.record_kind}:${row.record_id}`] = row.content_sha256;
    }

    if (row.record_kind === "evolution_evidence") {
      const timestamp =
        typeof parsed.timestamp === "string" && parsed.timestamp.trim().length > 0
          ? parsed.timestamp
          : null;
      const proposalId =
        typeof parsed.proposal_id === "string" && parsed.proposal_id.trim().length > 0
          ? parsed.proposal_id
          : null;
      if (!timestamp || !proposalId) {
        hitMalformedRow = true;
        break;
      }

      // Evolution evidence has its own shape
      evidenceEntries.push({
        timestamp,
        proposal_id: proposalId,
        skill_name: parsed.skill_name as string,
        skill_path: (parsed.skill_path as string) ?? "",
        target: (parsed.target as EvolutionEvidenceEntry["target"]) ?? "description",
        stage: (parsed.stage as EvolutionEvidenceEntry["stage"]) ?? "created",
        rationale: parsed.rationale as string | undefined,
        confidence: parsed.confidence as number | undefined,
        details: parsed.details as string | undefined,
        original_text: parsed.original_text as string | undefined,
        proposed_text: parsed.proposed_text as string | undefined,
        eval_set: parsed.eval_set_json as EvolutionEvidenceEntry["eval_set"],
        validation: parsed.validation_json as EvolutionEvidenceEntry["validation"],
        evidence_id: parsed.evidence_id as string | undefined,
      });
    } else if (row.record_kind === "orchestrate_run") {
      // Orchestrate run records -- pass through as-is
      orchestrateRuns.push(parsed);
    } else if (row.record_kind === "grading_result") {
      gradingResults.push(parsed);
    } else if (row.record_kind === "improvement_signal") {
      improvementSignals.push(parsed);
    } else {
      // Canonical telemetry records -- pass through as-is
      canonicalRecords.push(parsed as unknown as CanonicalRecord);
    }

    lastParsedSeq = row.local_seq;
  }

  // If nothing parsed successfully, return null
  if (
    canonicalRecords.length === 0 &&
    evidenceEntries.length === 0 &&
    orchestrateRuns.length === 0 &&
    gradingResults.length === 0 &&
    improvementSignals.length === 0
  ) {
    return null;
  }

  const payload: BuildV2Result["payload"] = buildPushPayloadV2(
    canonicalRecords,
    evidenceEntries,
    orchestrateRuns,
    gradingResults,
    improvementSignals,
  );

  // Attach content hashes for server-side dedup
  if (Object.keys(contentHashes).length > 0) {
    payload.content_hashes = contentHashes;
  }

  if (lastParsedSeq === null) {
    return null;
  }
  const lastSeq = lastParsedSeq;

  if (hitMalformedRow && (process.env.DEBUG || process.env.NODE_ENV === "development")) {
    console.error(
      "[alpha-upload/build-payloads] encountered malformed staged row; cursor held at last valid seq",
    );
  }

  return { payload, lastSeq };
}
