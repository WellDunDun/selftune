import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type SkillSetOutcomeStatus = "improved" | "inconclusive" | "regressed";
export type SkillSetOutcomeMetricDirection = "improved" | "stable" | "regressed" | "unavailable";

export interface SkillSetOutcomeMetric {
  before: number | null;
  after: number | null;
  delta: number | null;
  direction: SkillSetOutcomeMetricDirection;
  before_samples: number;
  after_samples: number;
}

export interface SkillSetOutcomeMetrics {
  completion_quality: SkillSetOutcomeMetric;
  error_rate: SkillSetOutcomeMetric;
  trigger_coverage: SkillSetOutcomeMetric;
  token_cost: SkillSetOutcomeMetric;
  grading: SkillSetOutcomeMetric;
}

export interface SkillSetOutcomeSession {
  session_id: string;
  timestamp: string;
  cwd: string;
  completion_status: "completed" | "failed" | "interrupted" | "cancelled" | "unknown" | null;
  errors_encountered: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface SkillSetOutcomeObservation {
  session_id: string;
  skill_name: string;
  triggered: boolean;
}

export interface SkillSetOutcomeGradingResult {
  session_id: string;
  skill_name: string;
  pass_rate: number | null;
}

export interface SkillSetActivation {
  review_id: string;
  receipt_id: string;
  set_id: string;
  algorithm_version: string;
  project_root: string;
  activated_at: string;
  skill_names: string[];
}

export interface SkillSetOutcome {
  outcome_id: string;
  review_id: string;
  receipt_id: string;
  set_id: string;
  algorithm_version: string;
  project_root: string;
  activated_at: string;
  measured_at: string;
  status: SkillSetOutcomeStatus;
  reason: string;
  causal_claim: false;
  minimum_sessions: number;
  before_session_count: number;
  after_session_count: number;
  metrics: SkillSetOutcomeMetrics;
}

export interface MeasureSkillSetOutcomeInput {
  activation: SkillSetActivation;
  sessions: ReadonlyArray<SkillSetOutcomeSession>;
  observations: ReadonlyArray<SkillSetOutcomeObservation>;
  gradingResults: ReadonlyArray<SkillSetOutcomeGradingResult>;
  minSessions?: number;
  maxSessions?: number;
  now?: Date;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function average(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((total, value) => total + value, 0) / values.length);
}

function compareMetric(input: {
  before: ReadonlyArray<number>;
  after: ReadonlyArray<number>;
  minimumChange: number;
  higherIsBetter: boolean;
  relativeThreshold?: boolean;
}): SkillSetOutcomeMetric {
  const before = average(input.before);
  const after = average(input.after);
  if (before === null || after === null) {
    return {
      before,
      after,
      delta: null,
      direction: "unavailable",
      before_samples: input.before.length,
      after_samples: input.after.length,
    };
  }
  const delta = round(after - before);
  const threshold = input.relativeThreshold
    ? Math.max(Math.abs(before) * input.minimumChange, 1)
    : input.minimumChange;
  const meaningful = Math.abs(delta) >= threshold;
  const improved = input.higherIsBetter ? delta > 0 : delta < 0;
  return {
    before,
    after,
    delta,
    direction: !meaningful ? "stable" : improved ? "improved" : "regressed",
    before_samples: input.before.length,
    after_samples: input.after.length,
  };
}

function normalizedSkillName(value: string): string {
  return value.trim().toLowerCase();
}

function isProjectSession(projectRoot: string, cwd: string): boolean {
  if (!cwd.trim()) return false;
  const pathFromRoot = relative(projectRoot, resolve(cwd));
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function observationsForSessions(
  observations: ReadonlyArray<SkillSetOutcomeObservation>,
  sessionIds: ReadonlySet<string>,
  skillNames: ReadonlySet<string>,
): SkillSetOutcomeObservation[] {
  return observations.filter(
    (row) => sessionIds.has(row.session_id) && skillNames.has(normalizedSkillName(row.skill_name)),
  );
}

function gradingForSessions(
  rows: ReadonlyArray<SkillSetOutcomeGradingResult>,
  sessionIds: ReadonlySet<string>,
  skillNames: ReadonlySet<string>,
): number[] {
  return rows.flatMap((row) =>
    sessionIds.has(row.session_id) &&
    skillNames.has(normalizedSkillName(row.skill_name)) &&
    row.pass_rate !== null
      ? [row.pass_rate]
      : [],
  );
}

function completionValues(sessions: ReadonlyArray<SkillSetOutcomeSession>): number[] {
  return sessions.flatMap((session) => {
    if (!session.completion_status || session.completion_status === "unknown") return [];
    return [session.completion_status === "completed" ? 1 : 0];
  });
}

function tokenValues(sessions: ReadonlyArray<SkillSetOutcomeSession>): number[] {
  return sessions.flatMap((session) => {
    if (session.input_tokens === null && session.output_tokens === null) return [];
    return [(session.input_tokens ?? 0) + (session.output_tokens ?? 0)];
  });
}

export function measureSkillSetOutcome(input: MeasureSkillSetOutcomeInput): SkillSetOutcome {
  const minSessions = Math.max(1, input.minSessions ?? 5);
  const maxSessions = Math.max(minSessions, input.maxSessions ?? 20);
  const projectRoot = resolve(input.activation.project_root);
  const eligible = input.sessions
    .filter((session) => isProjectSession(projectRoot, session.cwd))
    .toSorted(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.session_id.localeCompare(right.session_id),
    );
  const beforeEligible = eligible.filter(
    (session) => session.timestamp < input.activation.activated_at,
  );
  const afterEligible = eligible.filter(
    (session) => session.timestamp >= input.activation.activated_at,
  );
  const comparisonSize = Math.min(beforeEligible.length, afterEligible.length, maxSessions);
  const before = beforeEligible.slice(-comparisonSize);
  const after = afterEligible.slice(0, comparisonSize);
  const beforeIds = new Set(before.map((session) => session.session_id));
  const afterIds = new Set(after.map((session) => session.session_id));
  const skillNames = new Set(input.activation.skill_names.map(normalizedSkillName));
  const beforeObservations = observationsForSessions(input.observations, beforeIds, skillNames);
  const afterObservations = observationsForSessions(input.observations, afterIds, skillNames);

  const metrics: SkillSetOutcomeMetrics = {
    completion_quality: compareMetric({
      before: completionValues(before),
      after: completionValues(after),
      minimumChange: 0.05,
      higherIsBetter: true,
    }),
    error_rate: compareMetric({
      before: before.map((session) => session.errors_encountered),
      after: after.map((session) => session.errors_encountered),
      minimumChange: 0.25,
      higherIsBetter: false,
    }),
    trigger_coverage: compareMetric({
      before: beforeObservations.map((row) => (row.triggered ? 1 : 0)),
      after: afterObservations.map((row) => (row.triggered ? 1 : 0)),
      minimumChange: 0.05,
      higherIsBetter: true,
    }),
    token_cost: compareMetric({
      before: tokenValues(before),
      after: tokenValues(after),
      minimumChange: 0.1,
      higherIsBetter: false,
      relativeThreshold: true,
    }),
    grading: compareMetric({
      before: gradingForSessions(input.gradingResults, beforeIds, skillNames),
      after: gradingForSessions(input.gradingResults, afterIds, skillNames),
      minimumChange: 0.05,
      higherIsBetter: true,
    }),
  };
  const directions = Object.values(metrics).map((metric) => metric.direction);
  const improvedMetrics = directions.filter((direction) => direction === "improved").length;
  const regressedMetrics = directions.filter((direction) => direction === "regressed").length;
  const enoughSessions = before.length >= minSessions && after.length >= minSessions;
  const status: SkillSetOutcomeStatus = !enoughSessions
    ? "inconclusive"
    : improvedMetrics >= 2 && regressedMetrics === 0
      ? "improved"
      : regressedMetrics >= 2 && improvedMetrics === 0
        ? "regressed"
        : "inconclusive";
  const reason = !enoughSessions
    ? `Outcome is inconclusive until at least ${minSessions} sessions exist on both sides of activation.`
    : status === "improved"
      ? `${improvedMetrics} measured dimensions improved without a measured regression.`
      : status === "regressed"
        ? `${regressedMetrics} measured dimensions regressed without a measured improvement.`
        : "The observed dimensions were stable, unavailable, or moved in mixed directions.";
  const outcomeId = createHash("sha256")
    .update(`${input.activation.review_id}\u0000${input.activation.receipt_id}`)
    .digest("hex")
    .slice(0, 24);

  return {
    outcome_id: `outcome-${outcomeId}`,
    review_id: input.activation.review_id,
    receipt_id: input.activation.receipt_id,
    set_id: input.activation.set_id,
    algorithm_version: input.activation.algorithm_version,
    project_root: projectRoot,
    activated_at: input.activation.activated_at,
    measured_at: (input.now ?? new Date()).toISOString(),
    status,
    reason: `${reason} This observational before/after comparison is not a causal estimate.`,
    causal_claim: false,
    minimum_sessions: minSessions,
    before_session_count: before.length,
    after_session_count: after.length,
    metrics,
  };
}
