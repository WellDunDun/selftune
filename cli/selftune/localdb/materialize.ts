/**
 * Materializer: reads JSONL source-of-truth logs and inserts structured
 * records into the local SQLite database.
 *
 * Supports two modes:
 *  - Full rebuild: drops all data and re-inserts from scratch
 *  - Incremental: only inserts records newer than last materialization
 */

// NOTE: With dual-write active (Phase 1+), hooks insert directly into SQLite.
// The materializer is only needed for:
//   1. Initial startup (to catch pre-existing JSONL data from before dual-write)
//   2. Manual rebuild via `selftune rebuild-db`
//   3. Backfill from batch ingestors that don't yet dual-write

import type { Database } from "bun:sqlite";
import {
  type CanonicalExecutionFactRecord,
  type CanonicalPromptRecord,
  type CanonicalRecord,
  type CanonicalSessionRecord,
  type CanonicalSkillInvocationRecord,
  isCanonicalRecord,
} from "@selftune/telemetry-contract";
import {
  CANONICAL_LOG,
  EVOLUTION_AUDIT_LOG,
  EVOLUTION_EVIDENCE_LOG,
  ORCHESTRATE_RUN_LOG,
  TELEMETRY_LOG,
} from "../constants.js";
import type { OrchestrateRunReport } from "../dashboard-contract.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { readCanonicalRecords } from "../utils/canonical-log.js";
import { readJsonl, readJsonlFrom } from "../utils/jsonl.js";
import { readEffectiveSkillUsageRecords } from "../utils/skill-log.js";
import { getMeta, setMeta } from "./db.js";

/** Meta key tracking last materialization timestamp. */
const META_LAST_MATERIALIZED = "last_materialized_at";
/** Meta key prefix for per-file byte offsets (append-only incremental reads). */
const META_OFFSET_PREFIX = "file_offset:";

/**
 * Full rebuild: drop all data tables, then re-insert everything.
 */
export function materializeFull(db: Database, options?: MaterializeOptions): MaterializeResult {
  const tables = [
    "session_telemetry",
    "evolution_audit",
    "evolution_evidence",
    "execution_facts",
    "skill_invocations",
    "prompts",
    "sessions",
    "orchestrate_runs",
  ];
  for (const table of tables) {
    db.run(`DELETE FROM ${table}`);
  }
  // Clear byte offsets so full rebuild reads from start of each file
  db.run("DELETE FROM _meta WHERE key LIKE ?", [`${META_OFFSET_PREFIX}%`]);

  return materializeIncremental(db, { ...options, since: null });
}

export interface MaterializeOptions {
  canonicalLogPath?: string;
  telemetryLogPath?: string;
  evolutionAuditPath?: string;
  evolutionEvidencePath?: string;
  orchestrateRunLogPath?: string;
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
  orchestrateRuns: number;
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
    orchestrateRuns: 0,
  };

  // -- Read only NEW data using byte offsets -----------------------------------
  // Append-only JSONL files: track byte offset per file in _meta so we only
  // read bytes appended since the last materialization. Falls back to full
  // read when since is null (first run / full rebuild).

  function getOffset(filePath: string): number {
    if (!since) return 0; // full rebuild — read everything
    const raw = getMeta(db, `${META_OFFSET_PREFIX}${filePath}`);
    return raw ? Number.parseInt(raw, 10) : 0;
  }
  const newOffsets: Array<[string, number]> = [];

  const canonicalPath = options?.canonicalLogPath ?? CANONICAL_LOG;
  let filteredCanonical: CanonicalRecord[];
  if (!since) {
    filteredCanonical = readCanonicalRecords(canonicalPath);
  } else {
    const { records, newOffset } = readJsonlFrom<CanonicalRecord>(
      canonicalPath,
      getOffset(canonicalPath),
    );
    filteredCanonical = records.filter(isCanonicalRecord);
    newOffsets.push([canonicalPath, newOffset]);
  }

  // Pre-partition canonical records by kind (single pass instead of 4x full scan)
  const byKind = new Map<string, CanonicalRecord[]>();
  for (const r of filteredCanonical) {
    const arr = byKind.get(r.record_kind);
    if (arr) arr.push(r);
    else byKind.set(r.record_kind, [r]);
  }

  const telemetryPath = options?.telemetryLogPath ?? TELEMETRY_LOG;
  let filteredTelemetry: SessionTelemetryRecord[];
  if (!since) {
    filteredTelemetry = readJsonl<SessionTelemetryRecord>(telemetryPath);
  } else {
    const { records, newOffset } = readJsonlFrom<SessionTelemetryRecord>(
      telemetryPath,
      getOffset(telemetryPath),
    );
    filteredTelemetry = records;
    newOffsets.push([telemetryPath, newOffset]);
  }

  // Skill usage uses a merge of raw + repaired logs — always full read
  // since readEffectiveSkillUsageRecords handles dedup internally.
  // However, when doing incremental, filter by timestamp.
  const skills = readEffectiveSkillUsageRecords();
  const filteredSkills = since ? skills.filter((r) => r.timestamp > since) : skills;

  const auditPath = options?.evolutionAuditPath ?? EVOLUTION_AUDIT_LOG;
  let filteredAudit: EvolutionAuditEntry[];
  if (!since) {
    filteredAudit = readJsonl<EvolutionAuditEntry>(auditPath);
  } else {
    const { records, newOffset } = readJsonlFrom<EvolutionAuditEntry>(
      auditPath,
      getOffset(auditPath),
    );
    filteredAudit = records;
    newOffsets.push([auditPath, newOffset]);
  }

  const evidencePath = options?.evolutionEvidencePath ?? EVOLUTION_EVIDENCE_LOG;
  let filteredEvidence: EvolutionEvidenceEntry[];
  if (!since) {
    filteredEvidence = readJsonl<EvolutionEvidenceEntry>(evidencePath);
  } else {
    const { records, newOffset } = readJsonlFrom<EvolutionEvidenceEntry>(
      evidencePath,
      getOffset(evidencePath),
    );
    filteredEvidence = records;
    newOffsets.push([evidencePath, newOffset]);
  }

  const orchestratePath = options?.orchestrateRunLogPath ?? ORCHESTRATE_RUN_LOG;
  let filteredOrchestrateRuns: OrchestrateRunReport[];
  if (!since) {
    filteredOrchestrateRuns = readJsonl<OrchestrateRunReport>(orchestratePath);
  } else {
    const { records, newOffset } = readJsonlFrom<OrchestrateRunReport>(
      orchestratePath,
      getOffset(orchestratePath),
    );
    filteredOrchestrateRuns = records;
    newOffsets.push([orchestratePath, newOffset]);
  }

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
    result.orchestrateRuns = insertOrchestrateRuns(db, filteredOrchestrateRuns);

    // Persist byte offsets so next incremental run skips already-read data
    for (const [filePath, offset] of newOffsets) {
      setMeta(db, `${META_OFFSET_PREFIX}${filePath}`, String(offset));
    }
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
  // Use upsert to merge non-null fields from duplicate session records.
  // Multiple canonical records may exist for the same session (e.g., Stop hook
  // writes one without model, replay ingestor writes another with model).
  const stmt = db.prepare(`
    INSERT INTO sessions
      (session_id, started_at, ended_at, platform, model, completion_status,
       source_session_kind, agent_cli, workspace_path, repo_remote, branch,
       schema_version, normalized_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at = COALESCE(sessions.started_at, excluded.started_at),
      ended_at = COALESCE(sessions.ended_at, excluded.ended_at),
      model = COALESCE(sessions.model, excluded.model),
      completion_status = COALESCE(sessions.completion_status, excluded.completion_status),
      agent_cli = COALESCE(sessions.agent_cli, excluded.agent_cli),
      repo_remote = COALESCE(sessions.repo_remote, excluded.repo_remote),
      branch = COALESCE(sessions.branch, excluded.branch),
      workspace_path = COALESCE(sessions.workspace_path, excluded.workspace_path)
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
  // Ensure session stubs exist for FK satisfaction — hooks may write
  // skill_invocation records before a full session record is available.
  const sessionStub = db.prepare(`
    INSERT OR IGNORE INTO sessions
      (session_id, platform, schema_version, normalized_at)
    VALUES (?, ?, ?, ?)
  `);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
       triggered, confidence, tool_name, matched_prompt_id, agent_type,
       query, skill_path, skill_scope, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    const si = r as CanonicalSkillInvocationRecord;
    sessionStub.run(
      si.session_id,
      si.platform ?? "unknown",
      si.schema_version ?? "1.0.0",
      si.normalized_at ?? new Date().toISOString(),
    );
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
      si.agent_type ?? null,
      ((si as Record<string, unknown>).query as string) ?? null,
      ((si as Record<string, unknown>).skill_path as string) ?? null,
      ((si as Record<string, unknown>).skill_scope as string) ?? null,
      ((si as Record<string, unknown>).source as string) ?? null,
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
    INSERT INTO session_telemetry
      (session_id, timestamp, cwd, transcript_path, tool_calls_json,
       total_tool_calls, bash_commands_json, skills_triggered_json,
       skills_invoked_json, assistant_turns, errors_encountered,
       transcript_chars, last_user_query, source, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      timestamp = excluded.timestamp,
      tool_calls_json = excluded.tool_calls_json,
      total_tool_calls = excluded.total_tool_calls,
      bash_commands_json = excluded.bash_commands_json,
      skills_triggered_json = excluded.skills_triggered_json,
      skills_invoked_json = excluded.skills_invoked_json,
      assistant_turns = excluded.assistant_turns,
      errors_encountered = excluded.errors_encountered,
      transcript_chars = excluded.transcript_chars,
      last_user_query = excluded.last_user_query,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens
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
  // Skill usage records now go into the unified skill_invocations table.
  // Uses INSERT OR IGNORE with the dedup index on skill_invocations.
  const sessionStub = db.prepare(`
    INSERT OR IGNORE INTO sessions
      (session_id, platform, schema_version, normalized_at)
    VALUES (?, ?, ?, ?)
  `);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
       triggered, confidence, tool_name, matched_prompt_id, agent_type,
       query, skill_path, skill_scope, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    // Ensure session stub exists for FK satisfaction
    sessionStub.run(r.session_id, "unknown", "1.0.0", new Date().toISOString());

    // Derive a unique skill_invocation_id for skill_usage records
    const invocationId = `${r.session_id}:su:${r.timestamp}:${r.skill_name}`;

    stmt.run(
      invocationId,
      r.session_id,
      r.timestamp, // timestamp → occurred_at
      r.skill_name,
      null, // invocation_mode — not available from skill_usage
      r.triggered ? 1 : 0,
      null, // confidence — not available from skill_usage
      null, // tool_name — not available from skill_usage
      null, // matched_prompt_id — not available from skill_usage
      null, // agent_type — not available from skill_usage
      r.query,
      r.skill_path,
      r.skill_scope ?? null,
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
      (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json, iterations_used)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
      r.iterations_used ?? null,
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

function insertOrchestrateRuns(db: Database, records: OrchestrateRunReport[]): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO orchestrate_runs
      (run_id, timestamp, elapsed_ms, dry_run, approval_mode,
       total_skills, evaluated, evolved, deployed, watched, skipped,
       skill_actions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const r of records) {
    stmt.run(
      r.run_id,
      r.timestamp,
      r.elapsed_ms,
      r.dry_run ? 1 : 0,
      r.approval_mode,
      r.total_skills,
      r.evaluated,
      r.evolved,
      r.deployed,
      r.watched,
      r.skipped,
      JSON.stringify(r.skill_actions),
    );
    count++;
  }
  return count;
}
