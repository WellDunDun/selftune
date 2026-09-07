import type { Database } from "bun:sqlite";

import { asc, eq } from "drizzle-orm";
import * as Schema from "effect/Schema";
import { getDrizzleDb } from "@selftune/local-store";
import {
  skill_classification_corrections,
  skill_classification_overrides,
  skill_set_outcomes,
  skill_set_suggestion_reviews,
  skill_set_suggestion_snapshots,
} from "@selftune/local-store/schema";

import { sanitizeConservative } from "../contribute/sanitize.js";

const Category = Schema.Literals([
  "software_development",
  "testing_quality",
  "data_ai",
  "research",
  "writing_content",
  "design",
  "product_business",
  "operations_automation",
  "communication",
  "security",
  "agent_tooling",
  "general",
]);
const ReviewDecision = Schema.Literals(["accepted", "edited", "dismissed"]);
const ReviewReason = Schema.Literals([
  "accepted_as_suggested",
  "edited_before_creation",
  "not_relevant_now",
  "skills_should_remain_separate",
  "not_a_real_pattern",
  "already_have_workflow",
  "other",
]);
const OutcomeStatus = Schema.Literals(["improved", "inconclusive", "regressed"]);

const LearnedOverride = Schema.Struct({
  skill_id: Schema.String,
  skill_name: Schema.String,
  category: Category,
  inferred_category: Category,
  reason: Schema.NullOr(Schema.String),
  algorithm_version: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
const LearnedCorrection = Schema.Struct({
  correction_id: Schema.String,
  skill_id: Schema.String,
  skill_name: Schema.String,
  category: Schema.NullOr(Category),
  inferred_category: Category,
  reason: Schema.NullOr(Schema.String),
  algorithm_version: Schema.String,
  corrected_at: Schema.String,
});
const LearnedSnapshot = Schema.Struct({
  snapshot_id: Schema.String,
  suggestion_id: Schema.String,
  evidence_fingerprint: Schema.String,
  pattern: Schema.String,
  algorithm_version: Schema.String,
  evidence_version: Schema.Number,
  suggestion_json: Schema.String,
  generated_at: Schema.String,
  first_seen_at: Schema.String,
  last_seen_at: Schema.String,
});
const LearnedReview = Schema.Struct({
  review_id: Schema.String,
  snapshot_id: Schema.String,
  suggestion_id: Schema.String,
  evidence_fingerprint: Schema.String,
  decision: ReviewDecision,
  reason_code: ReviewReason,
  reason: Schema.NullOr(Schema.String),
  resulting_set_id: Schema.NullOr(Schema.String),
  resulting_set_revision_hash: Schema.NullOr(Schema.String),
  result_json: Schema.NullOr(Schema.String),
  edit_distance: Schema.NullOr(Schema.Number),
  algorithm_version: Schema.String,
  reviewed_at: Schema.String,
});
const LearnedOutcome = Schema.Struct({
  outcome_id: Schema.String,
  review_id: Schema.String,
  receipt_id: Schema.String,
  set_id: Schema.String,
  algorithm_version: Schema.String,
  project_root: Schema.Literal("[REMOTE_PROJECT]"),
  activated_at: Schema.String,
  measured_at: Schema.String,
  status: OutcomeStatus,
  reason: Schema.String,
  minimum_sessions: Schema.Number,
  before_session_count: Schema.Number,
  after_session_count: Schema.Number,
  metrics_json: Schema.String,
});

export class SkillIntelligenceLearnedState extends Schema.Class<SkillIntelligenceLearnedState>(
  "SkillIntelligenceLearnedState",
)({
  version: Schema.Literal(1),
  exported_at: Schema.String,
  overrides: Schema.Array(LearnedOverride),
  corrections: Schema.Array(LearnedCorrection),
  snapshots: Schema.Array(LearnedSnapshot),
  reviews: Schema.Array(LearnedReview),
  outcomes: Schema.Array(LearnedOutcome),
}) {}

const SnapshotForRemote = Schema.Struct({
  suggestion_id: Schema.String,
  evidence_fingerprint: Schema.String,
  name: Schema.String,
  description: Schema.String,
  pattern: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      category: Category,
      role: Schema.optional(Schema.String),
      source_id: Schema.optional(Schema.NullOr(Schema.String)),
      membership_score: Schema.optional(Schema.Number),
    }),
  ),
  harnesses: Schema.Array(Schema.String),
  evidence_state: Schema.optionalKey(Schema.String),
  confidence: Schema.Number,
  occurrence_count: Schema.Number,
  discovery_occurrence_count: Schema.optionalKey(Schema.Number),
  held_out_occurrence_count: Schema.optionalKey(Schema.Number),
  support: Schema.Number,
  held_out_support: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  affinity: Schema.NullOr(Schema.Number),
  held_out_affinity: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  discovery_edge_coverage: Schema.optional(Schema.NullOr(Schema.Number)),
  held_out_edge_coverage: Schema.optional(Schema.NullOr(Schema.Number)),
  sequence_consistency: Schema.NullOr(Schema.Number),
  held_out_sequence_consistency: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  synergy_score: Schema.NullOr(Schema.Number),
  reason: Schema.String,
});

function redactedReason(value: string | null): string | null {
  return value ? "[REDACTED_LOCAL_NOTE]" : null;
}

function remoteSuggestionJson(value: string): string {
  const suggestion = Schema.decodeUnknownSync(SnapshotForRemote)(JSON.parse(value));
  return JSON.stringify({
    ...suggestion,
    evidence_state: suggestion.evidence_state ?? "exploratory",
    discovery_occurrence_count:
      suggestion.discovery_occurrence_count ?? suggestion.occurrence_count,
    held_out_occurrence_count: suggestion.held_out_occurrence_count ?? 0,
    held_out_support: suggestion.held_out_support ?? null,
    held_out_affinity: suggestion.held_out_affinity ?? null,
    held_out_sequence_consistency: suggestion.held_out_sequence_consistency ?? null,
    description: sanitizeConservative(suggestion.description),
    reason: sanitizeConservative(suggestion.reason),
    project_root: null,
    skills: suggestion.skills.map((skill) => ({
      ...skill,
      role: skill.role ? sanitizeConservative(skill.role) : undefined,
      package_path: "",
    })),
  });
}

function remoteReviewResult(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.filter(Schema.is(Schema.String)));
    }
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ edited_fields: Schema.Array(Schema.String) }),
    )(parsed);
    return JSON.stringify({ edited_fields: result.edited_fields });
  } catch {
    return JSON.stringify({ edited_fields: [] });
  }
}

export function exportSkillIntelligenceLearnedState(
  sqlite: Database,
  now?: Date,
): SkillIntelligenceLearnedState {
  const db = getDrizzleDb(sqlite);
  const overrides = db
    .select()
    .from(skill_classification_overrides)
    .orderBy(asc(skill_classification_overrides.skill_id))
    .all()
    .map((row) =>
      Schema.decodeUnknownSync(LearnedOverride)({
        ...row,
        reason: redactedReason(row.reason),
      }),
    );
  const corrections = db
    .select()
    .from(skill_classification_corrections)
    .orderBy(
      asc(skill_classification_corrections.corrected_at),
      asc(skill_classification_corrections.correction_id),
    )
    .all()
    .map((row) =>
      Schema.decodeUnknownSync(LearnedCorrection)({
        ...row,
        reason: redactedReason(row.reason),
      }),
    );
  const snapshots = db
    .select()
    .from(skill_set_suggestion_snapshots)
    .orderBy(asc(skill_set_suggestion_snapshots.snapshot_id))
    .all()
    .map((row) => ({ ...row, suggestion_json: remoteSuggestionJson(row.suggestion_json) }));
  const reviews = db
    .select()
    .from(skill_set_suggestion_reviews)
    .orderBy(
      asc(skill_set_suggestion_reviews.reviewed_at),
      asc(skill_set_suggestion_reviews.review_id),
    )
    .all()
    .map((row) =>
      Schema.decodeUnknownSync(LearnedReview)({
        ...row,
        reason: redactedReason(row.reason),
        result_json: remoteReviewResult(row.result_json),
      }),
    );
  const outcomes = db
    .select()
    .from(skill_set_outcomes)
    .orderBy(asc(skill_set_outcomes.measured_at), asc(skill_set_outcomes.outcome_id))
    .all()
    .map((row) =>
      Schema.decodeUnknownSync(LearnedOutcome)({
        ...row,
        project_root: "[REMOTE_PROJECT]",
        reason: sanitizeConservative(row.reason),
      }),
    );
  const exportedAt =
    now?.toISOString() ??
    [
      ...overrides.map((row) => row.updated_at),
      ...corrections.map((row) => row.corrected_at),
      ...snapshots.map((row) => row.last_seen_at),
      ...reviews.map((row) => row.reviewed_at),
      ...outcomes.map((row) => row.measured_at),
    ].toSorted((left, right) => right.localeCompare(left))[0] ??
    "1970-01-01T00:00:00.000Z";
  return SkillIntelligenceLearnedState.make({
    version: 1,
    exported_at: exportedAt,
    overrides,
    corrections,
    snapshots,
    reviews,
    outcomes,
  });
}

export interface MergeSkillIntelligenceLearnedStateResult {
  overrides: number;
  corrections: number;
  snapshots: number;
  reviews: number;
  outcomes: number;
}

export function mergeSkillIntelligenceLearnedState(
  sqlite: Database,
  input: typeof SkillIntelligenceLearnedState.Encoded,
): MergeSkillIntelligenceLearnedStateResult {
  const payload = Schema.decodeUnknownSync(SkillIntelligenceLearnedState)(input);
  const db = getDrizzleDb(sqlite);
  const result: MergeSkillIntelligenceLearnedStateResult = {
    overrides: 0,
    corrections: 0,
    snapshots: 0,
    reviews: 0,
    outcomes: 0,
  };

  for (const row of payload.overrides) {
    const existing = db
      .select({ updated_at: skill_classification_overrides.updated_at })
      .from(skill_classification_overrides)
      .where(eq(skill_classification_overrides.skill_id, row.skill_id))
      .get();
    if (existing && existing.updated_at >= row.updated_at) continue;
    db.insert(skill_classification_overrides)
      .values(row)
      .onConflictDoUpdate({
        target: skill_classification_overrides.skill_id,
        set: row,
      })
      .run();
    result.overrides += 1;
  }
  for (const row of payload.corrections) {
    const existing = db
      .select({ id: skill_classification_corrections.correction_id })
      .from(skill_classification_corrections)
      .where(eq(skill_classification_corrections.correction_id, row.correction_id))
      .get();
    if (existing) continue;
    db.insert(skill_classification_corrections).values(row).run();
    result.corrections += 1;
  }
  for (const row of payload.snapshots) {
    const existing = db
      .select({ last_seen_at: skill_set_suggestion_snapshots.last_seen_at })
      .from(skill_set_suggestion_snapshots)
      .where(eq(skill_set_suggestion_snapshots.snapshot_id, row.snapshot_id))
      .get();
    if (existing && existing.last_seen_at >= row.last_seen_at) continue;
    db.insert(skill_set_suggestion_snapshots)
      .values(row)
      .onConflictDoUpdate({
        target: skill_set_suggestion_snapshots.snapshot_id,
        set: {
          suggestion_json: row.suggestion_json,
          last_seen_at: row.last_seen_at,
        },
      })
      .run();
    result.snapshots += 1;
  }
  for (const row of payload.reviews) {
    const existing = db
      .select({ reviewed_at: skill_set_suggestion_reviews.reviewed_at })
      .from(skill_set_suggestion_reviews)
      .where(eq(skill_set_suggestion_reviews.review_id, row.review_id))
      .get();
    if (existing && existing.reviewed_at >= row.reviewed_at) continue;
    db.insert(skill_set_suggestion_reviews)
      .values(row)
      .onConflictDoUpdate({
        target: skill_set_suggestion_reviews.review_id,
        set: {
          reason_code: row.reason_code,
          reason: row.reason,
          resulting_set_id: row.resulting_set_id,
          resulting_set_revision_hash: row.resulting_set_revision_hash,
          result_json: row.result_json,
          edit_distance: row.edit_distance,
          reviewed_at: row.reviewed_at,
        },
      })
      .run();
    result.reviews += 1;
  }
  for (const row of payload.outcomes) {
    const existing = db
      .select({ measured_at: skill_set_outcomes.measured_at })
      .from(skill_set_outcomes)
      .where(eq(skill_set_outcomes.outcome_id, row.outcome_id))
      .get();
    if (existing && existing.measured_at >= row.measured_at) continue;
    db.insert(skill_set_outcomes)
      .values(row)
      .onConflictDoUpdate({
        target: skill_set_outcomes.outcome_id,
        set: {
          measured_at: row.measured_at,
          status: row.status,
          reason: row.reason,
          before_session_count: row.before_session_count,
          after_session_count: row.after_session_count,
          metrics_json: row.metrics_json,
        },
      })
      .run();
    result.outcomes += 1;
  }
  return result;
}
