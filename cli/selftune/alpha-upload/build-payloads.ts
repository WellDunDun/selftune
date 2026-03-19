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
import type { CanonicalRecord } from "@selftune/telemetry-contract";
import { buildPushPayloadV2 } from "../canonical-export.js";
import type { EvolutionEvidenceEntry } from "../types.js";

// -- Types --------------------------------------------------------------------

export interface BuildV2Result {
  payload: Record<string, unknown>;
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
    SELECT local_seq, record_kind, record_json
    FROM canonical_upload_staging
    ${whereClause}
    ORDER BY local_seq ASC
    LIMIT ?
  `;

  const rows = db.query(sql).all(...params) as Array<{
    local_seq: number;
    record_kind: string;
    record_json: string;
  }>;

  if (rows.length === 0) return null;

  const canonicalRecords: CanonicalRecord[] = [];
  const evidenceEntries: EvolutionEvidenceEntry[] = [];
  const orchestrateRuns: Record<string, unknown>[] = [];

  for (const row of rows) {
    const parsed = safeParseJson<Record<string, unknown>>(row.record_json);
    if (!parsed) continue;

    if (row.record_kind === "evolution_evidence") {
      // Evolution evidence has its own shape
      evidenceEntries.push({
        timestamp: (parsed.timestamp as string) ?? new Date().toISOString(),
        proposal_id: parsed.proposal_id as string,
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
    } else {
      // Canonical telemetry records -- pass through as-is
      canonicalRecords.push(parsed as unknown as CanonicalRecord);
    }
  }

  // If nothing parsed successfully, return null
  if (canonicalRecords.length === 0 && evidenceEntries.length === 0 && orchestrateRuns.length === 0) {
    return null;
  }

  const payload = buildPushPayloadV2(canonicalRecords, evidenceEntries, orchestrateRuns);
  const lastSeq = rows[rows.length - 1].local_seq;

  return { payload, lastSeq };
}
