import type { Database } from "bun:sqlite";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { OrchestrateRunReport, PendingProposal } from "../../dashboard-contract.js";
import type { evolution_audit, evolution_evidence, orchestrate_runs } from "../drizzle-schema.js";
import { safeParseJson, safeParseJsonObjectArray } from "./json.js";

const decodeSkillActions = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          skill: Schema.String,
          action: Schema.Literals(["evolve", "package-search", "watch", "skip"]),
          reason: Schema.String,
          deployed: Schema.optionalKey(Schema.Boolean),
          rolledBack: Schema.optionalKey(Schema.Boolean),
          alert: Schema.optionalKey(Schema.NullOr(Schema.String)),
          elapsed_ms: Schema.optionalKey(Schema.Number),
          llm_calls: Schema.optionalKey(Schema.Number),
        }),
      ),
    ),
  ),
);

export function queryEvolutionAudit(db: Database, skillName?: string) {
  const sql = skillName
    ? `SELECT * FROM evolution_audit
       WHERE skill_name = ?
          OR (skill_name IS NULL AND proposal_id LIKE 'evo-' || ? || '-%')
       ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_audit ORDER BY timestamp DESC`;
  const rows = db
    .query<typeof evolution_audit.$inferSelect, string[]>(sql)
    .all(...(skillName ? [skillName, skillName] : []));

  return rows.map((row) => ({
    timestamp: row.timestamp,
    proposal_id: row.proposal_id,
    skill_name: row.skill_name ?? undefined,
    action: row.action,
    details: row.details ?? "",
    eval_snapshot: row.eval_snapshot_json ? safeParseJson(row.eval_snapshot_json) : undefined,
    validation_mode: row.validation_mode ?? undefined,
    validation_agent: row.validation_agent ?? undefined,
    validation_fixture_id: row.validation_fixture_id ?? undefined,
    validation_evidence_ref: row.validation_evidence_ref ?? undefined,
  }));
}

export function queryEvolutionEvidence(db: Database, skillName?: string) {
  const sql = skillName
    ? `SELECT * FROM evolution_evidence WHERE skill_name = ? ORDER BY timestamp DESC`
    : `SELECT * FROM evolution_evidence ORDER BY timestamp DESC`;
  const rows = db
    .query<typeof evolution_evidence.$inferSelect, string[]>(sql)
    .all(...(skillName ? [skillName] : []));

  return rows.map((row) => ({
    timestamp: row.timestamp,
    proposal_id: row.proposal_id,
    skill_name: row.skill_name,
    skill_path: row.skill_path ?? "",
    target: row.target ?? "",
    stage: row.stage ?? "",
    rationale: row.rationale ?? undefined,
    confidence: row.confidence ?? undefined,
    details: row.details ?? undefined,
    original_text: row.original_text ?? undefined,
    proposed_text: row.proposed_text ?? undefined,
    eval_set: row.eval_set_json ? safeParseJsonObjectArray(row.eval_set_json) : undefined,
    validation: row.validation_json ? safeParseJson(row.validation_json) : undefined,
  }));
}

export function getPendingProposals(db: Database, skillName?: string): PendingProposal[] {
  const whereClause = skillName ? "WHERE ea.skill_name = ? AND" : "WHERE";
  const params = skillName ? [skillName] : [];

  return db
    .query<
      Pick<
        typeof evolution_audit.$inferSelect,
        "proposal_id" | "action" | "timestamp" | "details" | "skill_name"
      >,
      string[]
    >(
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
    .all(...params)
    .map((row) => ({
      ...row,
      details: row.details ?? "",
      skill_name: row.skill_name ?? undefined,
    }));
}

export function getOrchestrateRuns(db: Database, limit = 20): OrchestrateRunReport[] {
  const rows = db
    .query<typeof orchestrate_runs.$inferSelect, [number]>(
      `SELECT run_id, timestamp, elapsed_ms, dry_run, approval_mode,
              total_skills, evaluated, evolved, deployed, watched, skipped,
              skill_actions_json
       FROM orchestrate_runs
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit);

  return rows.map((row) => ({
    run_id: row.run_id,
    timestamp: row.timestamp,
    elapsed_ms: row.elapsed_ms,
    dry_run: row.dry_run === 1,
    approval_mode: row.approval_mode === "auto" ? "auto" : "review",
    total_skills: row.total_skills,
    evaluated: row.evaluated,
    evolved: row.evolved,
    deployed: row.deployed,
    watched: row.watched,
    skipped: row.skipped,
    skill_actions: Option.getOrElse(decodeSkillActions(row.skill_actions_json), () => []),
  }));
}
