/**
 * Direct-write module for SQLite-first architecture.
 *
 * Uses the singleton DB connection from db.ts (no open/close per call).
 * Prepared statements are cached per Database instance via WeakMap to
 * avoid re-parsing SQL on every insert (~10x faster for repeated writes).
 *
 * All public functions are fail-open: they catch errors internally and
 * never throw. Hooks must never block the host agent.
 */

import type { Database } from "bun:sqlite";
import type {
  CanonicalExecutionFactRecord,
  CanonicalPromptRecord,
  CanonicalRecord,
  CanonicalSessionRecord,
  CanonicalSkillInvocationRecord,
} from "@selftune/telemetry-contract";
import type { OrchestrateRunReport } from "../dashboard-contract.js";
import type {
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { getDb } from "./db.js";

// -- Consolidated skill invocation input --------------------------------------

/** Extended skill invocation with usage metadata for consolidated writes. */
export interface SkillInvocationWriteInput {
  // All CanonicalSkillInvocationRecord fields
  skill_invocation_id: string;
  session_id: string;
  occurred_at: string;
  skill_name: string;
  invocation_mode: string;
  triggered: boolean;
  confidence: number;
  tool_name?: string;
  matched_prompt_id?: string;
  agent_type?: string;
  platform?: string;
  schema_version?: string;
  normalized_at?: string;
  // Extra fields from skill_usage
  query?: string;
  skill_path?: string;
  skill_scope?: string;
  source?: string;
}

// -- Prepared statement cache -------------------------------------------------

type Statement = ReturnType<Database["prepare"]>;
const stmtCache = new WeakMap<Database, Map<string, Statement>>();

function getStmt(db: Database, key: string, sql: string): Statement {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(key);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(key, stmt);
  }
  return stmt;
}

// -- Fail-open wrapper --------------------------------------------------------

function safeWrite(label: string, fn: (db: Database) => void): boolean {
  try {
    fn(getDb());
    return true;
  } catch (err) {
    if (process.env.DEBUG || process.env.NODE_ENV === "development") {
      console.error(`[direct-write] ${label} failed:`, err);
    }
    return false;
  }
}

// -- Canonical record dispatcher -----------------------------------------------

export function writeCanonicalToDb(record: CanonicalRecord): boolean {
  return safeWrite("canonical", (db) => {
    switch (record.record_kind) {
      case "session":
        insertSession(db, record as CanonicalSessionRecord);
        break;
      case "prompt":
        insertPrompt(db, record as CanonicalPromptRecord);
        break;
      case "skill_invocation":
        insertSkillInvocation(
          db,
          record as CanonicalSkillInvocationRecord as SkillInvocationWriteInput,
        );
        break;
      case "execution_fact":
        insertExecutionFact(db, record as CanonicalExecutionFactRecord);
        break;
      case "normalization_run":
        break; // no-op — not persisted to SQLite
    }
  });
}

export function writeCanonicalBatchToDb(records: CanonicalRecord[]): boolean {
  if (records.length === 0) return true;
  return safeWrite("canonical-batch", (db) => {
    db.run("BEGIN TRANSACTION");
    try {
      for (const record of records) {
        switch (record.record_kind) {
          case "session":
            insertSession(db, record as CanonicalSessionRecord);
            break;
          case "prompt":
            insertPrompt(db, record as CanonicalPromptRecord);
            break;
          case "skill_invocation":
            insertSkillInvocation(
              db,
              record as CanonicalSkillInvocationRecord as SkillInvocationWriteInput,
            );
            break;
          case "execution_fact":
            insertExecutionFact(db, record as CanonicalExecutionFactRecord);
            break;
          case "normalization_run":
            break; // no-op — not persisted to SQLite
        }
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
  });
}

// -- Individual table writers --------------------------------------------------

export function writeSessionToDb(record: CanonicalSessionRecord): boolean {
  return safeWrite("session", (db) => insertSession(db, record));
}

export function writePromptToDb(record: CanonicalPromptRecord): boolean {
  return safeWrite("prompt", (db) => insertPrompt(db, record));
}

export function writeSkillInvocationToDb(
  record: CanonicalSkillInvocationRecord | SkillInvocationWriteInput,
): boolean {
  return safeWrite("skill-invocation", (db) => insertSkillInvocation(db, record));
}

/** Write a unified skill check — replaces both writeSkillUsageToDb and writeSkillInvocationToDb. */
export function writeSkillCheckToDb(input: SkillInvocationWriteInput): boolean {
  return writeSkillInvocationToDb(input);
}

export function writeExecutionFactToDb(record: CanonicalExecutionFactRecord): boolean {
  return safeWrite("execution-fact", (db) => insertExecutionFact(db, record));
}

export function writeSessionTelemetryToDb(record: SessionTelemetryRecord): boolean {
  return safeWrite("session-telemetry", (db) => {
    getStmt(
      db,
      "session-telemetry",
      `
      INSERT OR IGNORE INTO session_telemetry
        (session_id, timestamp, cwd, transcript_path, tool_calls_json,
         total_tool_calls, bash_commands_json, skills_triggered_json,
         skills_invoked_json, assistant_turns, errors_encountered,
         transcript_chars, last_user_query, source, input_tokens, output_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      record.session_id,
      record.timestamp,
      record.cwd,
      record.transcript_path,
      JSON.stringify(record.tool_calls),
      record.total_tool_calls,
      JSON.stringify(record.bash_commands),
      JSON.stringify(record.skills_triggered),
      record.skills_invoked ? JSON.stringify(record.skills_invoked) : null,
      record.assistant_turns,
      record.errors_encountered,
      record.transcript_chars,
      record.last_user_query,
      record.source ?? null,
      record.input_tokens ?? null,
      record.output_tokens ?? null,
    );
  });
}

/** @deprecated Use writeSkillCheckToDb() instead. Writes to the legacy skill_usage table. */
export function writeSkillUsageToDb(record: SkillUsageRecord): boolean {
  return safeWrite("skill-usage", (db) => {
    getStmt(
      db,
      "skill-usage",
      `
      INSERT OR IGNORE INTO skill_usage
        (timestamp, session_id, skill_name, skill_path, skill_scope, query, triggered, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      record.timestamp,
      record.session_id,
      record.skill_name,
      record.skill_path,
      record.skill_scope ?? null,
      record.query,
      record.triggered ? 1 : 0,
      record.source ?? null,
    );
  });
}

export function writeEvolutionAuditToDb(record: EvolutionAuditEntry): boolean {
  return safeWrite("evolution-audit", (db) => {
    getStmt(
      db,
      "evolution-audit",
      `
      INSERT OR IGNORE INTO evolution_audit
        (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      record.timestamp,
      record.proposal_id,
      record.skill_name ?? null,
      record.action,
      record.details,
      record.eval_snapshot ? JSON.stringify(record.eval_snapshot) : null,
    );
  });
}

export function writeEvolutionEvidenceToDb(record: EvolutionEvidenceEntry): boolean {
  return safeWrite("evolution-evidence", (db) => {
    getStmt(
      db,
      "evolution-evidence",
      `
      INSERT OR IGNORE INTO evolution_evidence
        (timestamp, proposal_id, skill_name, skill_path, target, stage,
         rationale, confidence, details, original_text, proposed_text,
         eval_set_json, validation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      record.timestamp,
      record.proposal_id,
      record.skill_name,
      record.skill_path,
      record.target,
      record.stage,
      record.rationale ?? null,
      record.confidence ?? null,
      record.details ?? null,
      record.original_text ?? null,
      record.proposed_text ?? null,
      record.eval_set ? JSON.stringify(record.eval_set) : null,
      record.validation ? JSON.stringify(record.validation) : null,
    );
  });
}

export function writeOrchestrateRunToDb(record: OrchestrateRunReport): boolean {
  return safeWrite("orchestrate-run", (db) => {
    getStmt(
      db,
      "orchestrate-run",
      `
      INSERT OR IGNORE INTO orchestrate_runs
        (run_id, timestamp, elapsed_ms, dry_run, approval_mode,
         total_skills, evaluated, evolved, deployed, watched, skipped,
         skill_actions_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      record.run_id,
      record.timestamp,
      record.elapsed_ms,
      record.dry_run ? 1 : 0,
      record.approval_mode,
      record.total_skills,
      record.evaluated,
      record.evolved,
      record.deployed,
      record.watched,
      record.skipped,
      JSON.stringify(record.skill_actions),
    );
  });
}

export function writeQueryToDb(record: {
  timestamp: string;
  session_id: string;
  query: string;
  source?: string;
}): boolean {
  return safeWrite("query", (db) => {
    getStmt(
      db,
      "query",
      `
      INSERT OR IGNORE INTO queries (timestamp, session_id, query, source)
      VALUES (?, ?, ?, ?)
    `,
    ).run(record.timestamp, record.session_id, record.query, record.source ?? null);
  });
}

export function writeImprovementSignalToDb(record: {
  timestamp: string;
  session_id: string;
  query: string;
  signal_type: string;
  mentioned_skill?: string;
  consumed: boolean;
  consumed_at?: string;
  consumed_by_run?: string;
}): boolean {
  return safeWrite("improvement-signal", (db) => {
    getStmt(
      db,
      "improvement-signal",
      `
      INSERT OR IGNORE INTO improvement_signals
        (timestamp, session_id, query, signal_type, mentioned_skill, consumed, consumed_at, consumed_by_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      record.timestamp,
      record.session_id,
      record.query,
      record.signal_type,
      record.mentioned_skill ?? null,
      record.consumed ? 1 : 0,
      record.consumed_at ?? null,
      record.consumed_by_run ?? null,
    );
  });
}

export function updateSignalConsumed(
  sessionId: string,
  query: string,
  signalType: string,
  runId: string,
): boolean {
  return safeWrite("signal-consumed", (db) => {
    getStmt(
      db,
      "signal-consumed",
      `
      UPDATE improvement_signals
      SET consumed = 1, consumed_at = ?, consumed_by_run = ?
      WHERE session_id = ? AND query = ? AND signal_type = ? AND consumed = 0
    `,
    ).run(new Date().toISOString(), runId, sessionId, query, signalType);
  });
}

// -- Internal insert helpers (used by cached statements) ----------------------

function insertSession(db: Database, s: CanonicalSessionRecord): void {
  getStmt(
    db,
    "session",
    `
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
  `,
  ).run(
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
}

function insertPrompt(db: Database, p: CanonicalPromptRecord): void {
  getStmt(
    db,
    "prompt",
    `
    INSERT OR IGNORE INTO prompts
      (prompt_id, session_id, occurred_at, prompt_kind, is_actionable, prompt_index, prompt_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    p.prompt_id,
    p.session_id,
    p.occurred_at,
    p.prompt_kind,
    p.is_actionable ? 1 : 0,
    p.prompt_index ?? null,
    p.prompt_text,
  );
}

function insertSkillInvocation(
  db: Database,
  si: CanonicalSkillInvocationRecord | SkillInvocationWriteInput,
): void {
  getStmt(
    db,
    "session-stub",
    `
    INSERT OR IGNORE INTO sessions (session_id, platform, schema_version, normalized_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(
    si.session_id,
    si.platform ?? "unknown",
    si.schema_version ?? "1.0.0",
    si.normalized_at ?? new Date().toISOString(),
  );

  // Cast to extended input to access optional usage fields
  const ext = si as SkillInvocationWriteInput;

  getStmt(
    db,
    "skill-invocation",
    `
    INSERT OR IGNORE INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
       triggered, confidence, tool_name, matched_prompt_id, agent_type,
       query, skill_path, skill_scope, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
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
    ext.query ?? null,
    ext.skill_path ?? null,
    ext.skill_scope ?? null,
    ext.source ?? null,
  );
}

function insertExecutionFact(db: Database, ef: CanonicalExecutionFactRecord): void {
  getStmt(
    db,
    "execution-fact",
    `
    INSERT INTO execution_facts
      (session_id, occurred_at, prompt_id, tool_calls_json, total_tool_calls,
       assistant_turns, errors_encountered, input_tokens, output_tokens,
       duration_ms, completion_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
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
}
