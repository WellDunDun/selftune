/**
 * Materializer: reads JSONL source-of-truth logs and inserts structured
 * records into the local SQLite database.
 *
 * Supports two modes:
 *  - Full rebuild: drops all data and re-inserts from scratch
 *  - Incremental: only inserts records newer than last materialization
 */

import type { Database } from "bun:sqlite";
import type {
  CanonicalExecutionFactRecord,
  CanonicalPromptRecord,
  CanonicalRecord,
  CanonicalSessionRecord,
  CanonicalSkillInvocationRecord,
} from "@selftune/telemetry-contract";
import {
  CANONICAL_LOG,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  TELEMETRY_LOG,
} from "../constants.js";
import { readEvidenceTrail } from "../evolution/evidence.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { readCanonicalRecords } from "../utils/canonical-log.js";
import { readJsonl } from "../utils/jsonl.js";
import { readEffectiveSkillUsageRecords } from "../utils/skill-log.js";
import { getMeta, setMeta } from "./db.js";

/** Meta key tracking last materialization timestamp. */
const META_LAST_MATERIALIZED = "last_materialized_at";

/**
 * Full rebuild: drop all data tables, then re-insert everything.
 */
export function materializeFull(db: Database, options?: MaterializeOptions): MaterializeResult {
  const tables = [
    "skill_usage",
    "session_telemetry",
    "evolution_audit",
    "evolution_evidence",
    "execution_facts",
    "skill_invocations",
    "prompts",
    "sessions",
  ];
  for (const table of tables) {
    db.run(`DELETE FROM ${table}`);
  }

  return materializeIncremental(db, { ...options, since: null });
}

export interface MaterializeOptions {
  canonicalLogPath?: string;
  telemetryLogPath?: string;
  evolutionAuditPath?: string;
  evolutionEvidencePath?: string;
  since?: string | null;
}

export interface MaterializeResult {
  sessions: number;
  prompts: number;
  skillInvocations: number;
  executionFacts: number;
  sessionTelemetry: number;
  skillUsage: number;
  evolutionAudit: number;
  evolutionEvidence: number;
}

/**
 * Incremental materialization: only insert records newer than last run.
 * Uses INSERT OR IGNORE for idempotency on primary-keyed tables,
 * and UNIQUE indexes for deduplication on append-only tables.
 */
export function materializeIncremental(
  db: Database,
  options?: MaterializeOptions,
): MaterializeResult {
  const since = options?.since !== undefined ? options.since : getMeta(db, META_LAST_MATERIALIZED);
  const now = new Date().toISOString();

  const result: MaterializeResult = {
    sessions: 0,
    prompts: 0,
    skillInvocations: 0,
    executionFacts: 0,
    sessionTelemetry: 0,
    skillUsage: 0,
    evolutionAudit: 0,
    evolutionEvidence: 0,
  };

  // -- Read all data BEFORE opening the transaction ---------------------------
  // This keeps file I/O out of the write lock for better concurrency.

  const canonical = readCanonicalRecords(options?.canonicalLogPath ?? CANONICAL_LOG);
  const filteredCanonical = since ? canonical.filter((r) => r.normalized_at > since) : canonical;

  // Pre-partition canonical records by kind (single pass instead of 4x full scan)
  const byKind = new Map<string, CanonicalRecord[]>();
  for (const r of filteredCanonical) {
    const arr = byKind.get(r.record_kind);
    if (arr) arr.push(r);
    else byKind.set(r.record_kind, [r]);
  }

  const telemetry = readJsonl<SessionTelemetryRecord>(options?.telemetryLogPath ?? TELEMETRY_LOG);
  const filteredTelemetry = since ? telemetry.filter((r) => r.timestamp > since) : telemetry;

  const skills = readEffectiveSkillUsageRecords();
  const filteredSkills = since ? skills.filter((r) => r.timestamp > since) : skills;

  const audit = readJsonl<EvolutionAuditEntry>(options?.evolutionAuditPath ?? EVOLUTION_AUDIT_LOG);
  const filteredAudit = since ? audit.filter((r) => r.timestamp > since) : audit;

  const evidence = readEvidenceTrail(
    undefined,
    options?.evolutionEvidencePath ?? EVOLUTION_EVIDENCE_LOG,
  );
  const filteredEvidence = since ? evidence.filter((r) => r.timestamp > since) : evidence;

  // -- Insert everything inside a single transaction --------------------------
  db.run("BEGIN TRANSACTION");
  try {
    result.sessions = insertSessions(db, byKind.get("session") ?? []);
    result.prompts = insertPrompts(db, byKind.get("prompt") ?? []);
    result.skillInvocations = insertSkillInvocations(db, byKind.get("skill_invocation") ?? []);
    result.executionFacts = insertExecutionFacts(db, byKind.get("execution_fact") ?? []);
    result.sessionTelemetry = insertSessionTelemetry(db, filteredTelemetry);
    result.skillUsage = insertSkillUsage(db, filteredSkills);
    result.evolutionAudit = insertEvolutionAudit(db, filteredAudit);
    result.evolutionEvidence = insertEvolutionEvidence(db, filteredEvidence);

    setMeta(db, META_LAST_MATERIALIZED, now);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }

  return result;
}

// -- Insert helpers -----------------------------------------------------------

function insertSessions(db: Database, records: CanonicalRecord[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions
      (session_id, started_at, ended_at, platform, model, completion_status,
       source_session_kind, agent_cli, workspace_path, repo_remote, branch,
       schema_version, normalized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    const s = r as CanonicalSessionRecord;
    stmt.run(
      s.session_id,
      s.started_at ?? null,
      s.ended_at ?? null,
      s.platform,
      s.model ?? null,
      s.completion_status ?? null,
      s.source_session_kind ?? null,
      s.agent_cli ?? null,
      s.workspace_path ?? null,
      s.repo_remote ?? null,
      s.branch ?? null,
      s.schema_version,
      s.normalized_at,
    );
    count++;
  }
  return count;
}

function insertPrompts(db: Database, records: CanonicalRecord[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO prompts
      (prompt_id, session_id, occurred_at, prompt_kind, is_actionable, prompt_index, prompt_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    const p = r as CanonicalPromptRecord;
    stmt.run(
      p.prompt_id,
      p.session_id,
      p.occurred_at,
      p.prompt_kind,
      p.is_actionable ? 1 : 0,
      p.prompt_index ?? null,
      p.prompt_text,
    );
    count++;
  }
  return count;
}

function insertSkillInvocations(db: Database, records: CanonicalRecord[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
       triggered, confidence, tool_name, matched_prompt_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    const si = r as CanonicalSkillInvocationRecord;
    stmt.run(
      si.skill_invocation_id,
      si.session_id,
      si.occurred_at,
      si.skill_name,
      si.invocation_mode,
      si.triggered ? 1 : 0,
      si.confidence,
      si.tool_name ?? null,
      si.matched_prompt_id ?? null,
    );
    count++;
  }
  return count;
}

function insertExecutionFacts(db: Database, records: CanonicalRecord[]): number {
  const stmt = db.prepare(`
    INSERT INTO execution_facts
      (session_id, occurred_at, prompt_id, tool_calls_json, total_tool_calls,
       assistant_turns, errors_encountered, input_tokens, output_tokens,
       duration_ms, completion_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    const ef = r as CanonicalExecutionFactRecord;
    stmt.run(
      ef.session_id,
      ef.occurred_at,
      ef.prompt_id ?? null,
      JSON.stringify(ef.tool_calls_json),
      ef.total_tool_calls,
      ef.assistant_turns,
      ef.errors_encountered,
      ef.input_tokens ?? null,
      ef.output_tokens ?? null,
      ef.duration_ms ?? null,
      ef.completion_status ?? null,
    );
    count++;
  }
  return count;
}

function insertSessionTelemetry(db: Database, records: SessionTelemetryRecord[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO session_telemetry
      (session_id, timestamp, cwd, transcript_path, tool_calls_json,
       total_tool_calls, bash_commands_json, skills_triggered_json,
       skills_invoked_json, assistant_turns, errors_encountered,
       transcript_chars, last_user_query, source, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    stmt.run(
      r.session_id,
      r.timestamp,
      r.cwd,
      r.transcript_path,
      JSON.stringify(r.tool_calls),
      r.total_tool_calls,
      JSON.stringify(r.bash_commands),
      JSON.stringify(r.skills_triggered),
      r.skills_invoked ? JSON.stringify(r.skills_invoked) : null,
      r.assistant_turns,
      r.errors_encountered,
      r.transcript_chars,
      r.last_user_query,
      r.source ?? null,
      r.input_tokens ?? null,
      r.output_tokens ?? null,
    );
    count++;
  }
  return count;
}

function insertSkillUsage(db: Database, records: SkillUsageRecord[]): number {
  // Uses INSERT OR IGNORE with a UNIQUE index on the dedup composite key
  // (idx_skill_usage_dedup defined in schema.ts).
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO skill_usage
      (timestamp, session_id, skill_name, skill_path, skill_scope, query, triggered, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    stmt.run(
      r.timestamp,
      r.session_id,
      r.skill_name,
      r.skill_path,
      r.skill_scope ?? null,
      r.query,
      r.triggered ? 1 : 0,
      r.source ?? null,
    );
    count++;
  }
  return count;
}

function insertEvolutionAudit(db: Database, records: EvolutionAuditEntry[]): number {
  // Uses INSERT OR IGNORE with a UNIQUE index on the dedup composite key
  // (idx_evo_audit_dedup defined in schema.ts).
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO evolution_audit
      (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    stmt.run(
      r.timestamp,
      r.proposal_id,
      r.skill_name ?? null,
      r.action,
      r.details,
      r.eval_snapshot ? JSON.stringify(r.eval_snapshot) : null,
    );
    count++;
  }
  return count;
}

function insertEvolutionEvidence(db: Database, records: EvolutionEvidenceEntry[]): number {
  // Uses INSERT OR IGNORE with a UNIQUE index on the dedup composite key
  // (idx_evo_evidence_dedup defined in schema.ts).
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO evolution_evidence
      (timestamp, proposal_id, skill_name, skill_path, target, stage,
       rationale, confidence, details, original_text, proposed_text,
       eval_set_json, validation_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    stmt.run(
      r.timestamp,
      r.proposal_id,
      r.skill_name,
      r.skill_path,
      r.target,
      r.stage,
      r.rationale ?? null,
      r.confidence ?? null,
      r.details ?? null,
      r.original_text ?? null,
      r.proposed_text ?? null,
      r.eval_set ? JSON.stringify(r.eval_set) : null,
      r.validation ? JSON.stringify(r.validation) : null,
    );
    count++;
  }
  return count;
}
