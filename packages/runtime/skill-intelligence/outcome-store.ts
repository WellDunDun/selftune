import type { Database } from "bun:sqlite";

import { desc } from "drizzle-orm";
import * as Schema from "effect/Schema";
import { getDb, getDrizzleDb } from "@selftune/local-store";
import { skill_set_outcomes } from "@selftune/local-store/schema";

import { queryGradingResults } from "../localdb/queries/monitoring.js";
import { queryTrustedSkillObservationRows } from "../localdb/queries/trust.js";
import { loadSkillIntelligenceFeedback } from "./feedback.js";
import {
  listSkillSetReceipts,
  listSkillSetRevisions,
  listSkillSets,
  type SkillSetManifest,
  type SkillSetReceipt,
} from "@selftune/library";
import type {
  SkillSetOutcome,
  SkillSetOutcomeMetricDirection,
  SkillSetOutcomeMetrics,
  SkillSetOutcomeStatus,
} from "@selftune/skill-intelligence/outcomes";
import {
  measureSkillSetOutcome,
  type SkillSetOutcomeGradingResult,
  type SkillSetOutcomeObservation,
  type SkillSetOutcomeSession,
} from "@selftune/skill-intelligence/outcomes";
import type { SkillSetSuggestionReview } from "@selftune/skill-intelligence/contract";

const MetricDirection = Schema.Literals(["improved", "stable", "regressed", "unavailable"]);
const Metric = Schema.Struct({
  before: Schema.NullOr(Schema.Number),
  after: Schema.NullOr(Schema.Number),
  delta: Schema.NullOr(Schema.Number),
  direction: MetricDirection,
  before_samples: Schema.Number,
  after_samples: Schema.Number,
});
const Metrics = Schema.Struct({
  completion_quality: Metric,
  error_rate: Metric,
  trigger_coverage: Metric,
  token_cost: Metric,
  grading: Metric,
});
const OutcomeSession = Schema.Struct({
  session_id: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.String,
  completion_status: Schema.NullOr(
    Schema.Literals(["completed", "failed", "interrupted", "cancelled", "unknown"]),
  ),
  errors_encountered: Schema.Number,
  input_tokens: Schema.NullOr(Schema.Number),
  output_tokens: Schema.NullOr(Schema.Number),
});

function status(value: string): SkillSetOutcomeStatus {
  if (value === "improved" || value === "inconclusive" || value === "regressed") return value;
  return "inconclusive";
}

function metrics(value: string): SkillSetOutcomeMetrics {
  return Schema.decodeUnknownSync(Metrics)(JSON.parse(value));
}

export function persistSkillSetOutcome(
  sqlite: Database,
  outcome: SkillSetOutcome,
): SkillSetOutcome {
  getDrizzleDb(sqlite)
    .insert(skill_set_outcomes)
    .values({
      outcome_id: outcome.outcome_id,
      review_id: outcome.review_id,
      receipt_id: outcome.receipt_id,
      set_id: outcome.set_id,
      algorithm_version: outcome.algorithm_version,
      project_root: outcome.project_root,
      activated_at: outcome.activated_at,
      measured_at: outcome.measured_at,
      status: outcome.status,
      reason: outcome.reason,
      minimum_sessions: outcome.minimum_sessions,
      before_session_count: outcome.before_session_count,
      after_session_count: outcome.after_session_count,
      metrics_json: JSON.stringify(outcome.metrics),
    })
    .onConflictDoUpdate({
      target: skill_set_outcomes.outcome_id,
      set: {
        measured_at: outcome.measured_at,
        status: outcome.status,
        reason: outcome.reason,
        before_session_count: outcome.before_session_count,
        after_session_count: outcome.after_session_count,
        metrics_json: JSON.stringify(outcome.metrics),
      },
    })
    .run();
  return outcome;
}

export function loadSkillSetOutcomes(sqlite: Database = getDb()): SkillSetOutcome[] {
  return getDrizzleDb(sqlite)
    .select()
    .from(skill_set_outcomes)
    .orderBy(desc(skill_set_outcomes.measured_at))
    .all()
    .map((row) => ({
      outcome_id: row.outcome_id,
      review_id: row.review_id,
      receipt_id: row.receipt_id,
      set_id: row.set_id,
      algorithm_version: row.algorithm_version,
      project_root: row.project_root,
      activated_at: row.activated_at,
      measured_at: row.measured_at,
      status: status(row.status),
      reason: row.reason,
      causal_claim: false,
      minimum_sessions: row.minimum_sessions,
      before_session_count: row.before_session_count,
      after_session_count: row.after_session_count,
      metrics: metrics(row.metrics_json),
    }));
}

function loadOutcomeSessions(sqlite: Database): SkillSetOutcomeSession[] {
  return sqlite
    .query(
      `SELECT telemetry.session_id, telemetry.timestamp, telemetry.cwd,
              COALESCE(
                sessions.completion_status,
                (SELECT facts.completion_status
                   FROM execution_facts AS facts
                  WHERE facts.session_id = telemetry.session_id
                    AND facts.completion_status IS NOT NULL
                  ORDER BY facts.id DESC
                  LIMIT 1)
              ) AS completion_status,
              COALESCE(telemetry.errors_encountered, 0) AS errors_encountered,
              telemetry.input_tokens, telemetry.output_tokens
         FROM session_telemetry AS telemetry
         LEFT JOIN sessions ON sessions.session_id = telemetry.session_id
        WHERE telemetry.cwd IS NOT NULL AND trim(telemetry.cwd) <> ''
        ORDER BY telemetry.timestamp ASC`,
    )
    .all()
    .map((row) => Schema.decodeUnknownSync(OutcomeSession)(row));
}

export interface RefreshSkillSetOutcomesOptions {
  db?: Database;
  configRoot?: string;
  reviews?: ReadonlyArray<SkillSetSuggestionReview>;
  receipts?: ReadonlyArray<SkillSetReceipt>;
  sets?: ReadonlyArray<SkillSetManifest>;
  setRevisions?: ReadonlyArray<SkillSetManifest>;
  sessions?: ReadonlyArray<SkillSetOutcomeSession>;
  observations?: ReadonlyArray<SkillSetOutcomeObservation>;
  gradingResults?: ReadonlyArray<SkillSetOutcomeGradingResult>;
  minSessions?: number;
  maxSessions?: number;
  now?: Date;
}

export function refreshSkillSetOutcomes(
  options: RefreshSkillSetOutcomesOptions = {},
): SkillSetOutcome[] {
  const db = options.db ?? getDb();
  const serviceOptions = options.configRoot ? { configRoot: options.configRoot } : {};
  const reviews = options.reviews ?? loadSkillIntelligenceFeedback(db).suggestionReviews;
  const receipts = options.receipts ?? listSkillSetReceipts(serviceOptions);
  const sets = options.sets ?? listSkillSets(serviceOptions);
  const setRevisions =
    options.setRevisions ??
    (options.sets
      ? sets
      : sets.flatMap((set) => listSkillSetRevisions(set.set_id, serviceOptions)));
  const sessions = options.sessions ?? loadOutcomeSessions(db);
  const observations =
    options.observations ??
    queryTrustedSkillObservationRows(db).map((row) => ({
      session_id: row.session_id,
      skill_name: row.skill_name,
      triggered: row.triggered === 1,
    }));
  const gradingResults =
    options.gradingResults ??
    queryGradingResults(db).map((row) => ({
      session_id: row.session_id,
      skill_name: row.skill_name,
      pass_rate: row.pass_rate,
    }));
  const setsById = new Map(sets.map((set) => [set.set_id, set]));
  const revisionsByIdentity = new Map(
    setRevisions.map((set) => [`${set.set_id}\u0000${set.revision_hash}`, set]),
  );
  for (const review of reviews) {
    if (
      (review.decision !== "accepted" && review.decision !== "edited") ||
      !review.resulting_set_id
    ) {
      continue;
    }
    for (const receipt of receipts) {
      if (
        receipt.set_id !== review.resulting_set_id ||
        (review.resulting_set_revision_hash !== null &&
          receipt.set_revision_hash !== review.resulting_set_revision_hash) ||
        receipt.status !== "applied" ||
        receipt.applied_at < review.reviewed_at
      ) {
        continue;
      }
      const set =
        revisionsByIdentity.get(`${receipt.set_id}\u0000${receipt.set_revision_hash}`) ??
        setsById.get(receipt.set_id);
      if (!set) continue;
      const outcome = measureSkillSetOutcome({
        activation: {
          review_id: review.review_id,
          receipt_id: receipt.receipt_id,
          set_id: set.set_id,
          algorithm_version: review.algorithm_version,
          project_root: receipt.project_root,
          activated_at: receipt.applied_at,
          skill_names: set.skills.map((skill) => skill.name),
        },
        sessions,
        observations,
        gradingResults,
        minSessions: options.minSessions,
        maxSessions: options.maxSessions,
        now: options.now,
      });
      persistSkillSetOutcome(db, outcome);
    }
  }
  return loadSkillSetOutcomes(db);
}

export type { SkillSetOutcomeMetricDirection };
