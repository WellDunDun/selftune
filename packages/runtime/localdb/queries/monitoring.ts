import type { Database } from "bun:sqlite";

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
    .query(`SELECT * FROM improvement_signals${where} ORDER BY timestamp DESC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    timestamp: row.timestamp as string,
    session_id: row.session_id as string,
    query: row.query as string,
    signal_type: row.signal_type as string,
    mentioned_skill: row.mentioned_skill as string | undefined,
    consumed: (row.consumed as number) === 1,
    consumed_at: row.consumed_at as string | undefined,
    consumed_by_run: row.consumed_by_run as string | undefined,
  }));
}

export function queryGradingResults(db: Database): Array<{
  grading_id: string;
  session_id: string;
  skill_name: string;
  transcript_path: string | null;
  graded_at: string;
  pass_rate: number | null;
  mean_score: number | null;
  score_std_dev: number | null;
  passed_count: number | null;
  failed_count: number | null;
  total_count: number | null;
  expectations_json: string | null;
  claims_json: string | null;
  eval_feedback_json: string | null;
  failure_feedback_json: string | null;
  execution_metrics_json: string | null;
}> {
  return db
    .query(
      `SELECT grading_id, session_id, skill_name, transcript_path, graded_at,
              pass_rate, mean_score, score_std_dev, passed_count, failed_count, total_count,
              expectations_json, claims_json, eval_feedback_json, failure_feedback_json,
              execution_metrics_json
       FROM grading_results
       ORDER BY graded_at DESC`,
    )
    .all() as Array<{
    grading_id: string;
    session_id: string;
    skill_name: string;
    transcript_path: string | null;
    graded_at: string;
    pass_rate: number | null;
    mean_score: number | null;
    score_std_dev: number | null;
    passed_count: number | null;
    failed_count: number | null;
    total_count: number | null;
    expectations_json: string | null;
    claims_json: string | null;
    eval_feedback_json: string | null;
    failure_feedback_json: string | null;
    execution_metrics_json: string | null;
  }>;
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

  const rows = phase
    ? (db.query(sql).all(proposalId, phase) as Array<Record<string, unknown>>)
    : (db.query(sql).all(proposalId) as Array<Record<string, unknown>>);

  return rows.map((row) => ({
    id: row.id as number,
    proposal_id: row.proposal_id as string,
    skill_name: row.skill_name as string,
    validation_mode: row.validation_mode as string,
    phase: row.phase as string,
    query: row.query as string,
    should_trigger: (row.should_trigger as number) === 1,
    triggered: (row.triggered as number) === 1,
    passed: (row.passed as number) === 1,
    evidence: row.evidence as string | null,
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
    .query(
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
    .all(proposalId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    query: row.query as string,
    skill_name: row.skill_name as string,
    before_passed: (row.before_passed as number) === 1,
    after_passed: (row.after_passed as number) === 1,
  }));
}

export interface GradingBaselineRow {
  id: number;
  skill_name: string;
  proposal_id: string | null;
  measured_at: string;
  pass_rate: number;
  mean_score: number | null;
  sample_size: number;
  grading_results_json: string | null;
}

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
    return (
      (db
        .query(
          `SELECT * FROM grading_baselines
           WHERE skill_name = ? AND proposal_id = ?
           ORDER BY measured_at DESC
           LIMIT 1`,
        )
        .get(skillName, proposalId) as GradingBaselineRow | null) ?? null
    );
  }

  return (
    (db
      .query(
        `SELECT * FROM grading_baselines
         WHERE skill_name = ? AND proposal_id IS NULL
         ORDER BY measured_at DESC
         LIMIT 1`,
      )
      .get(skillName) as GradingBaselineRow | null) ?? null
  );
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
    .query(
      `SELECT grading_id, session_id, skill_name, graded_at,
              pass_rate, mean_score, total_count, passed_count, failed_count
       FROM grading_results
       WHERE skill_name = ?
       ORDER BY graded_at DESC
       LIMIT ?`,
    )
    .all(skillName, limit) as RecentGradingResultRow[];
}
