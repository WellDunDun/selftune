import type { Database } from "bun:sqlite";
import type {
  grading_results,
  grading_baselines,
  improvement_signals,
  replay_entry_results,
} from "../drizzle-schema.js";

export function queryImprovementSignals(
  db: Database,
  consumedOnly?: boolean,
): Array<{
  timestamp: string;
  session_id: string;
  query: string;
  signal_type: string;
  mentioned_skill?: string;
  consumed: boolean;
  consumed_at?: string;
  consumed_by_run?: string;
}> {
  const where =
    consumedOnly === undefined ? "" : consumedOnly ? " WHERE consumed = 1" : " WHERE consumed = 0";
  const rows = db
    .query<typeof improvement_signals.$inferSelect, []>(
      `SELECT * FROM improvement_signals${where} ORDER BY timestamp DESC`,
    )
    .all();
  return rows.map((row) => ({
    timestamp: row.timestamp,
    session_id: row.session_id,
    query: row.query,
    signal_type: row.signal_type,
    mentioned_skill: row.mentioned_skill ?? undefined,
    consumed: row.consumed === 1,
    consumed_at: row.consumed_at ?? undefined,
    consumed_by_run: row.consumed_by_run ?? undefined,
  }));
}

export function queryGradingResults(db: Database) {
  return db
    .query<typeof grading_results.$inferSelect, []>(
      `SELECT grading_id, session_id, skill_name, transcript_path, graded_at,
            pass_rate, mean_score, score_std_dev, passed_count, failed_count, total_count,
            expectations_json, claims_json, eval_feedback_json, failure_feedback_json,
            execution_metrics_json
     FROM grading_results ORDER BY graded_at DESC`,
    )
    .all();
}

export function queryReplayEntryResults(
  db: Database,
  proposalId: string,
  phase?: string,
): Array<{
  id: number;
  proposal_id: string;
  skill_name: string;
  validation_mode: string;
  phase: string;
  query: string;
  should_trigger: boolean;
  triggered: boolean;
  passed: boolean;
  evidence: string | null;
}> {
  const sql = phase
    ? `SELECT id, proposal_id, skill_name, validation_mode, phase, query,
              should_trigger, triggered, passed, evidence
       FROM replay_entry_results
       WHERE proposal_id = ? AND phase = ?
       ORDER BY id`
    : `SELECT id, proposal_id, skill_name, validation_mode, phase, query,
              should_trigger, triggered, passed, evidence
       FROM replay_entry_results
       WHERE proposal_id = ?
       ORDER BY id`;

  const statement = db.query<typeof replay_entry_results.$inferSelect, string[]>(sql);
  const rows = phase ? statement.all(proposalId, phase) : statement.all(proposalId);

  return rows.map((row) => ({
    id: row.id,
    proposal_id: row.proposal_id,
    skill_name: row.skill_name,
    validation_mode: row.validation_mode,
    phase: row.phase,
    query: row.query,
    should_trigger: row.should_trigger === 1,
    triggered: row.triggered === 1,
    passed: row.passed === 1,
    evidence: row.evidence,
  }));
}

export function queryReplayRegressions(
  db: Database,
  proposalId: string,
): Array<{
  query: string;
  skill_name: string;
  before_passed: boolean;
  after_passed: boolean;
}> {
  const rows = db
    .query<
      { query: string; skill_name: string; before_passed: number; after_passed: number },
      [string]
    >(
      `SELECT b.query, b.skill_name,
              b.passed AS before_passed,
              a.passed AS after_passed
       FROM replay_entry_results b
       JOIN replay_entry_results a
         ON b.proposal_id = a.proposal_id
         AND b.query = a.query
         AND b.skill_name = a.skill_name
       WHERE b.proposal_id = ?
         AND b.phase = 'before'
         AND a.phase = 'after'
         AND b.passed = 1
         AND a.passed = 0
       ORDER BY b.query`,
    )
    .all(proposalId);

  return rows.map((row) => ({
    query: row.query,
    skill_name: row.skill_name,
    before_passed: row.before_passed === 1,
    after_passed: row.after_passed === 1,
  }));
}

export type GradingBaselineRow = typeof grading_baselines.$inferSelect;

export interface GradeRegressionResult {
  before: GradingBaselineRow;
  after: GradingBaselineRow;
  delta_pass_rate: number;
  delta_mean_score: number | null;
  regressed: boolean;
}

export function queryGradingBaseline(
  db: Database,
  skillName: string,
  proposalId?: string,
): GradingBaselineRow | null {
  if (proposalId !== undefined) {
    return db
      .query<GradingBaselineRow, [string, string]>(
        `SELECT * FROM grading_baselines
           WHERE skill_name = ? AND proposal_id = ?
           ORDER BY measured_at DESC
           LIMIT 1`,
      )
      .get(skillName, proposalId);
  }

  return db
    .query<GradingBaselineRow, [string]>(
      `SELECT * FROM grading_baselines
         WHERE skill_name = ? AND proposal_id IS NULL
         ORDER BY measured_at DESC
         LIMIT 1`,
    )
    .get(skillName);
}

export function queryGradeRegression(
  db: Database,
  skillName: string,
  afterProposalId: string,
  beforeProposalId?: string,
): GradeRegressionResult | null {
  const before = queryGradingBaseline(db, skillName, beforeProposalId);
  const after = queryGradingBaseline(db, skillName, afterProposalId);
  if (!before || !after) return null;

  const deltaPR = after.pass_rate - before.pass_rate;
  const deltaMS =
    after.mean_score != null && before.mean_score != null
      ? after.mean_score - before.mean_score
      : null;

  return {
    before,
    after,
    delta_pass_rate: deltaPR,
    delta_mean_score: deltaMS,
    regressed: deltaPR < 0,
  };
}

export interface RecentGradingResultRow {
  grading_id: string;
  session_id: string;
  skill_name: string;
  graded_at: string;
  pass_rate: number | null;
  mean_score: number | null;
  total_count: number | null;
  passed_count: number | null;
  failed_count: number | null;
}

export function queryRecentGradingResults(
  db: Database,
  skillName: string,
  limit: number = 20,
): RecentGradingResultRow[] {
  return db
    .query<RecentGradingResultRow, [string, number]>(
      `SELECT grading_id, session_id, skill_name, graded_at,
              pass_rate, mean_score, total_count, passed_count, failed_count
       FROM grading_results
       WHERE skill_name = ?
       ORDER BY graded_at DESC
       LIMIT ?`,
    )
    .all(skillName, limit);
}
