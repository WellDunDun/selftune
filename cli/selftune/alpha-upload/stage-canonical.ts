/**
 * Canonical upload staging writer.
 *
 * Reads canonical records from the JSONL source-of-truth log and evolution
 * evidence from SQLite, then inserts them into a single monotonic staging
 * table for lossless upload batching.
 *
 * The staging table preserves the full canonical record JSON -- no field
 * dropping, no hardcoding of provenance fields.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import type { CanonicalRecord } from "@selftune/telemetry-contract";
import { isCanonicalRecord } from "@selftune/telemetry-contract";

import { CANONICAL_LOG } from "../constants.js";
import {
  getOrchestrateRuns,
  queryCanonicalRecordsForStaging,
  queryEvolutionEvidence,
  queryGradingResults,
  queryImprovementSignals,
} from "../localdb/queries.js";
import { readJsonl } from "../utils/jsonl.js";

// -- Helpers ------------------------------------------------------------------

/**
 * Generate a deterministic execution_fact_id from the record's natural key.
 *
 * Uses a SHA-256 hash of the composite key (session_id, occurred_at, prompt_id)
 * so that re-staging the same record always produces the same ID.
 */
export function generateExecutionFactId(record: Record<string, unknown>): string {
  const key = `${record.session_id}:${record.occurred_at}:${record.prompt_id ?? ""}`;
  return `ef_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * Generate a deterministic evidence_id from the evidence record's natural key.
 *
 * Uses a SHA-256 hash of the composite key (proposal_id, target, stage,
 * skill_name, timestamp) so that re-staging the same evidence event always produces the
 * same ID — but distinct events (e.g., two "validate" stages at different
 * times) get different IDs.
 */
export function generateEvidenceId(record: Record<string, unknown>): string {
  const key = `${record.proposal_id ?? ""}:${record.target ?? ""}:${record.stage ?? ""}:${record.skill_name ?? ""}:${record.timestamp ?? record.normalized_at ?? ""}`;
  return `ev_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * Generate a deterministic grading_id from the result's natural key.
 */
export function generateGradingId(record: Record<string, unknown>): string {
  const key = `${record.session_id}:${record.skill_name}:${record.graded_at}`;
  return `gr_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * Generate a deterministic signal_id from an improvement signal's natural key.
 */
export function generateSignalId(record: Record<string, unknown>): string {
  const key = `${record.session_id}:${record.query}:${record.signal_type}:${record.timestamp}`;
  return `sig_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * Enrich a raw parsed record: if it is an execution_fact missing
 * execution_fact_id, inject a deterministic one.
 *
 * Returns the (possibly enriched) record unchanged for all other kinds.
 */
function enrichRecord(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.record_kind !== "execution_fact") return raw;
  if (
    raw.execution_fact_id &&
    typeof raw.execution_fact_id === "string" &&
    raw.execution_fact_id.length > 0
  ) {
    return raw;
  }
  return { ...raw, execution_fact_id: generateExecutionFactId(raw) };
}

/**
 * Read canonical records from JSONL, enriching execution_facts that are
 * missing execution_fact_id before applying the canonical record validator.
 *
 * This ensures older canonical logs (written before execution_fact_id was
 * required) can still be staged and uploaded.
 */
function readAndEnrichCanonicalRecords(logPath: string): CanonicalRecord[] {
  const rawRecords = readJsonl<Record<string, unknown>>(logPath);
  const enriched = rawRecords.map(enrichRecord);
  return enriched.filter(isCanonicalRecord) as CanonicalRecord[];
}

/**
 * Extract a stable record_id from a canonical record.
 *
 * Uses the natural primary key for each record kind:
 *  - session: session_id
 *  - prompt: prompt_id
 *  - skill_invocation: skill_invocation_id
 *  - execution_fact: execution_fact_id
 *  - normalization_run: run_id
 */
function extractRecordId(record: CanonicalRecord): string {
  switch (record.record_kind) {
    case "session":
      return record.session_id;
    case "prompt":
      return record.prompt_id;
    case "skill_invocation":
      return record.skill_invocation_id;
    case "execution_fact":
      return record.execution_fact_id;
    case "normalization_run":
      return record.run_id;
  }
}

/**
 * Extract session_id from a canonical record (if the record has one).
 */
function extractSessionId(record: CanonicalRecord): string | null {
  if ("session_id" in record) return record.session_id;
  return null;
}

/**
 * Extract prompt_id from a canonical record (if the record has one).
 */
function extractPromptId(record: CanonicalRecord): string | null {
  if ("prompt_id" in record) return record.prompt_id;
  return null;
}

/**
 * Extract normalized_at from a canonical record.
 */
function extractNormalizedAt(record: CanonicalRecord): string {
  return record.normalized_at;
}

// -- Content hashing ----------------------------------------------------------

/**
 * Compute SHA256 hex digest of a string (for upload dedup).
 * Uses Bun's built-in CryptoHasher for zero-dependency hashing.
 */
export function computeContentSha256(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

// -- Main staging function ----------------------------------------------------

/**
 * Stage canonical records from the JSONL log and evolution evidence from SQLite
 * into the canonical_upload_staging table.
 *
 * Uses INSERT OR IGNORE for dedup by (record_kind, record_id).
 *
 * @param db - SQLite database handle
 * @param logPath - Path to canonical JSONL log (defaults to CANONICAL_LOG)
 * @returns Number of newly staged records
 */
export function stageCanonicalRecords(db: Database, logPath: string = CANONICAL_LOG): number {
  let staged = 0;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO canonical_upload_staging
      (record_kind, record_id, record_json, session_id, prompt_id, normalized_at, staged_at, content_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_kind, record_id) DO UPDATE SET
      content_sha256 = excluded.content_sha256
    WHERE canonical_upload_staging.content_sha256 IS NULL AND excluded.content_sha256 IS NOT NULL
  `);

  // 1. Stage canonical records from SQLite (default) or JSONL (custom logPath override)
  const records: CanonicalRecord[] =
    logPath === CANONICAL_LOG
      ? (queryCanonicalRecordsForStaging(db)
          .map(enrichRecord)
          .filter(isCanonicalRecord) as CanonicalRecord[])
      : readAndEnrichCanonicalRecords(logPath);
  for (const record of records) {
    const recordId = extractRecordId(record);
    const recordJson = JSON.stringify(record);
    const result = stmt.run(
      record.record_kind,
      recordId,
      recordJson,
      extractSessionId(record),
      extractPromptId(record),
      extractNormalizedAt(record),
      now,
      computeContentSha256(recordJson),
    );
    if (result.changes > 0) staged++;
  }

  // 2. Stage evolution evidence from SQLite
  try {
    const evidence = queryEvolutionEvidence(db);
    for (const entry of evidence) {
      const evidenceRecord: Record<string, unknown> = {
        skill_name: entry.skill_name,
        skill_path: entry.skill_path,
        proposal_id: entry.proposal_id,
        target: entry.target,
        stage: entry.stage,
        rationale: entry.rationale,
        confidence: entry.confidence,
        details: entry.details,
        original_text: entry.original_text,
        proposed_text: entry.proposed_text,
        eval_set_json: entry.eval_set,
        validation_json: entry.validation,
        timestamp: entry.timestamp,
      };
      // Generate deterministic evidence_id if not already present
      const evidenceId = generateEvidenceId(evidenceRecord);
      evidenceRecord.evidence_id = evidenceId;
      const recordId = evidenceId;
      const recordJson = JSON.stringify(evidenceRecord);

      const result = stmt.run(
        "evolution_evidence",
        recordId,
        recordJson,
        null, // no session_id for evolution evidence
        null, // no prompt_id
        entry.timestamp,
        now,
        computeContentSha256(recordJson),
      );
      if (result.changes > 0) staged++;
    }
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[stage-canonical] failed to stage evolution evidence:", err);
    }
  }

  // 3. Stage orchestrate runs from SQLite
  try {
    const runs = getOrchestrateRuns(db, 10000);
    for (const run of runs) {
      const recordJson = JSON.stringify({
        run_id: run.run_id,
        timestamp: run.timestamp,
        elapsed_ms: run.elapsed_ms,
        dry_run: run.dry_run,
        approval_mode: run.approval_mode,
        total_skills: run.total_skills,
        evaluated: run.evaluated,
        evolved: run.evolved,
        deployed: run.deployed,
        watched: run.watched,
        skipped: run.skipped,
        skill_actions: run.skill_actions,
      });

      const result = stmt.run(
        "orchestrate_run",
        run.run_id,
        recordJson,
        null, // no session_id for orchestrate runs
        null, // no prompt_id
        run.timestamp,
        now,
        computeContentSha256(recordJson),
      );
      if (result.changes > 0) staged++;
    }
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[stage-canonical] failed to stage orchestrate runs:", err);
    }
  }

  // 4. Stage grading results from SQLite
  try {
    const gradingResults = queryGradingResults(db);
    for (const gr of gradingResults) {
      const recordJson = JSON.stringify({
        grading_id: gr.grading_id,
        session_id: gr.session_id,
        skill_name: gr.skill_name,
        transcript_path: gr.transcript_path,
        graded_at: gr.graded_at,
        pass_rate: gr.pass_rate,
        mean_score: gr.mean_score,
        score_std_dev: gr.score_std_dev,
        passed_count: gr.passed_count,
        failed_count: gr.failed_count,
        total_count: gr.total_count,
        expectations_json: gr.expectations_json,
        claims_json: gr.claims_json,
        eval_feedback_json: gr.eval_feedback_json,
        failure_feedback_json: gr.failure_feedback_json,
        execution_metrics_json: gr.execution_metrics_json,
      });

      const result = stmt.run(
        "grading_result",
        gr.grading_id,
        recordJson,
        gr.session_id,
        null, // no prompt_id
        gr.graded_at,
        now,
        computeContentSha256(recordJson),
      );
      if (result.changes > 0) staged++;
    }
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[stage-canonical] failed to stage grading results:", err);
    }
  }

  // 5. Stage improvement signals from SQLite
  try {
    const signals = queryImprovementSignals(db);
    for (const sig of signals) {
      const signalId = generateSignalId(sig);
      const recordJson = JSON.stringify({
        signal_id: signalId,
        timestamp: sig.timestamp,
        session_id: sig.session_id,
        query: sig.query,
        signal_type: sig.signal_type,
        mentioned_skill: sig.mentioned_skill,
        consumed: sig.consumed,
        consumed_at: sig.consumed_at,
        consumed_by_run: sig.consumed_by_run,
      });

      const result = stmt.run(
        "improvement_signal",
        signalId,
        recordJson,
        sig.session_id,
        null, // no prompt_id
        sig.timestamp,
        now,
        computeContentSha256(recordJson),
      );
      if (result.changes > 0) staged++;
    }
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error("[stage-canonical] failed to stage improvement signals:", err);
    }
  }

  return staged;
}
