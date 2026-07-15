import type { Database } from "bun:sqlite";

import type { OrchestrateRunReport, PendingProposal } from "../../dashboard-contract.js";
import { safeParseJson, safeParseJsonArray } from "./json.js";

export function queryEvolutionAudit(
  db: Database,
  skillName?: string,
): Array<{
  timestamp: string;
  proposal_id: string;
  skill_name?: string;
  action: string;
  details: string;
  eval_snapshot?: Record<string, unknown>;
  validation_mode?: string;
  validation_agent?: string;
  validation_fixture_id?: string;
  validation_evidence_ref?: string;
}> {
  const sql = skillName
    ? `SELECT * FROM evolution_audit
       WHERE skill_name = ?
          OR (skill_name IS NULL AND proposal_id LIKE 'evo-' || ? || '-%')
       ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_audit ORDER BY timestamp DESC`;
  const rows = (skillName ? db.query(sql).all(skillName, skillName) : db.query(sql).all()) as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => ({
    timestamp: row.timestamp as string,
    proposal_id: row.proposal_id as string,
    skill_name: typeof row.skill_name === "string" ? row.skill_name : undefined,
    action: row.action as string,
    details: row.details as string,
    eval_snapshot: row.eval_snapshot_json
      ? (safeParseJson(row.eval_snapshot_json as string) as Record<string, unknown>)
      : undefined,
    validation_mode: typeof row.validation_mode === "string" ? row.validation_mode : undefined,
    validation_agent: typeof row.validation_agent === "string" ? row.validation_agent : undefined,
    validation_fixture_id:
      typeof row.validation_fixture_id === "string" ? row.validation_fixture_id : undefined,
    validation_evidence_ref:
      typeof row.validation_evidence_ref === "string" ? row.validation_evidence_ref : undefined,
  }));
}

export function queryEvolutionEvidence(
  db: Database,
  skillName?: string,
): Array<{
  timestamp: string;
  proposal_id: string;
  skill_name: string;
  skill_path: string;
  target: string;
  stage: string;
  rationale?: string;
  confidence?: number;
  details?: string;
  original_text?: string;
  proposed_text?: string;
  eval_set?: Record<string, unknown>[];
  validation?: Record<string, unknown>;
}> {
  const sql = skillName
    ? `SELECT * FROM evolution_evidence WHERE skill_name = ? ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_evidence ORDER BY timestamp DESC`;
  const rows = (skillName ? db.query(sql).all(skillName) : db.query(sql).all()) as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => ({
    timestamp: row.timestamp as string,
    proposal_id: row.proposal_id as string,
    skill_name: row.skill_name as string,
    skill_path: row.skill_path as string,
    target: row.target as string,
    stage: row.stage as string,
    rationale: row.rationale as string | undefined,
    confidence: row.confidence as number | undefined,
    details: row.details as string | undefined,
    original_text: row.original_text as string | undefined,
    proposed_text: row.proposed_text as string | undefined,
    eval_set: row.eval_set_json
      ? safeParseJsonArray<Record<string, unknown>>(row.eval_set_json as string)
      : undefined,
    validation: row.validation_json
      ? (safeParseJson(row.validation_json as string) as Record<string, unknown>)
      : undefined,
  }));
}

export function getPendingProposals(db: Database, skillName?: string): PendingProposal[] {
  const whereClause = skillName ? "WHERE ea.skill_name = ? AND" : "WHERE";
  const params = skillName ? [skillName] : [];

  return db
    .query(
      `WITH latest AS (
         SELECT ea.proposal_id, ea.action, ea.timestamp, ea.details, ea.skill_name,
                ROW_NUMBER() OVER (PARTITION BY ea.proposal_id ORDER BY ea.timestamp DESC, ea.id DESC) AS rn
         FROM evolution_audit ea
         LEFT JOIN evolution_audit ea2
           ON ea2.proposal_id = ea.proposal_id
           AND ea2.action IN ('deployed', 'rejected', 'rolled_back')
         ${whereClause} ea.action IN ('created', 'validated')
           AND ea2.id IS NULL
       )
       SELECT proposal_id, action, timestamp, details, skill_name
       FROM latest
       WHERE rn = 1
       ORDER BY timestamp DESC`,
    )
    .all(...params) as PendingProposal[];
}

export function getOrchestrateRuns(db: Database, limit = 20): OrchestrateRunReport[] {
  const rows = db
    .query(
      `SELECT run_id, timestamp, elapsed_ms, dry_run, approval_mode,
              total_skills, evaluated, evolved, deployed, watched, skipped,
              skill_actions_json
       FROM orchestrate_runs
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    run_id: string;
    timestamp: string;
    elapsed_ms: number;
    dry_run: number;
    approval_mode: string;
    total_skills: number;
    evaluated: number;
    evolved: number;
    deployed: number;
    watched: number;
    skipped: number;
    skill_actions_json: string;
  }>;

  return rows.map((row) => ({
    run_id: row.run_id,
    timestamp: row.timestamp,
    elapsed_ms: row.elapsed_ms,
    dry_run: row.dry_run === 1,
    approval_mode: row.approval_mode as "auto" | "review",
    total_skills: row.total_skills,
    evaluated: row.evaluated,
    evolved: row.evolved,
    deployed: row.deployed,
    watched: row.watched,
    skipped: row.skipped,
    skill_actions: safeParseJsonArray(row.skill_actions_json),
  }));
}
