import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { and, asc, desc, eq } from "drizzle-orm";
import * as Schema from "effect/Schema";
import { getDb, getDrizzleDb } from "@selftune/local-store";
import {
  skill_classification_corrections,
  skill_classification_overrides,
  skill_set_suggestion_reviews,
  skill_set_suggestion_snapshots,
} from "@selftune/local-store/schema";

import {
  calibrateSkillIntelligence,
  type SkillIntelligenceCalibration,
} from "@selftune/skill-intelligence/calibration";
import {
  SKILL_INTELLIGENCE_ALGORITHM_VERSION,
  type SkillCategoryId,
  type SkillClassificationCorrection,
  type SkillClassificationOverride,
  type SkillSetSuggestionReview,
  type SkillSetSuggestionReviewDecision,
  type SkillSetSuggestionReviewReasonCode,
} from "@selftune/skill-intelligence/contract";

const SuggestedSkillSnapshot = Schema.Struct({
  confidence: Schema.Number,
  name: Schema.String,
  description: Schema.String,
  harnesses: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const ReviewResult = Schema.Struct({
  edited_fields: Schema.Array(Schema.String),
  result: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      harnesses: Schema.Array(Schema.String),
      skills: Schema.Array(Schema.String),
    }),
  ),
});

export interface SkillSetSuggestionReviewResult {
  name: string;
  description: string;
  harnesses: string[];
  skills: string[];
}

interface SkillIntelligenceSnapshotReport {
  algorithm_version: string;
  evidence_version: number;
  generated_at: string;
  suggestions: ReadonlyArray<{
    suggestion_id: string;
    evidence_fingerprint: string;
    pattern: string;
  }>;
}

export interface SetSkillClassificationOverrideInput {
  skill_id: string;
  skill_name: string;
  category: SkillCategoryId | null;
  inferred_category: SkillCategoryId;
  reason?: string | null;
}

export interface SkillClassificationOverrideReceipt {
  skill_id: string;
  category: SkillCategoryId | null;
  source: "human" | "inferred";
  updated_at: string;
}

export interface ReviewSkillSetSuggestionInput {
  suggestion_id: string;
  evidence_fingerprint: string;
  decision: SkillSetSuggestionReviewDecision;
  reason_code: SkillSetSuggestionReviewReasonCode;
  reason?: string | null;
  resulting_set_id?: string | null;
  resulting_set_revision_hash?: string | null;
  edited_fields?: string[];
  result?: SkillSetSuggestionReviewResult;
}

export interface SkillIntelligenceFeedbackState {
  classificationOverrides: SkillClassificationOverride[];
  suggestionReviews: SkillSetSuggestionReview[];
  calibration: SkillIntelligenceCalibration;
}

export class SkillIntelligenceFeedbackError extends Error {
  readonly code: "INVALID_FEEDBACK" | "STALE_SUGGESTION";

  constructor(code: SkillIntelligenceFeedbackError["code"], message: string) {
    super(message);
    this.name = "SkillIntelligenceFeedbackError";
    this.code = code;
  }
}

function feedbackId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function snapshotId(suggestionId: string, evidenceFingerprint: string): string {
  return `snapshot-${feedbackId(`${suggestionId}\u0000${evidenceFingerprint}`)}`;
}

function category(value: string): SkillCategoryId {
  switch (value) {
    case "software_development":
    case "testing_quality":
    case "data_ai":
    case "research":
    case "writing_content":
    case "design":
    case "product_business":
    case "operations_automation":
    case "communication":
    case "security":
    case "agent_tooling":
    case "general":
      return value;
    default:
      throw new SkillIntelligenceFeedbackError(
        "INVALID_FEEDBACK",
        `Unknown skill category: ${value}`,
      );
  }
}

function decision(value: string): SkillSetSuggestionReviewDecision {
  if (value === "accepted" || value === "edited" || value === "dismissed") return value;
  throw new SkillIntelligenceFeedbackError(
    "INVALID_FEEDBACK",
    `Unknown suggestion decision: ${value}`,
  );
}

function reasonCode(value: string): SkillSetSuggestionReviewReasonCode {
  if (
    value === "accepted_as_suggested" ||
    value === "edited_before_creation" ||
    value === "not_relevant_now" ||
    value === "skills_should_remain_separate" ||
    value === "not_a_real_pattern" ||
    value === "already_have_workflow" ||
    value === "other"
  ) {
    return value;
  }
  throw new SkillIntelligenceFeedbackError(
    "INVALID_FEEDBACK",
    `Unknown suggestion review reason: ${value}`,
  );
}

function parseReviewResult(value: string | null): typeof ReviewResult.Type {
  if (!value) return ReviewResult.make({ edited_fields: [] });
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return ReviewResult.make({
        edited_fields: parsed.filter((item): item is string => typeof item === "string"),
      });
    }
    return Schema.decodeUnknownSync(ReviewResult)(parsed);
  } catch {
    return ReviewResult.make({ edited_fields: [] });
  }
}

function normalizedSet(values: ReadonlyArray<string>): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function setDistance(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  const leftSet = normalizedSet(left);
  const rightSet = normalizedSet(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  const intersection = [...leftSet].filter((value) => rightSet.has(value)).length;
  return 1 - intersection / union.size;
}

function normalizedEditDistance(
  snapshotJson: string,
  input: ReviewSkillSetSuggestionInput,
): number | null {
  if (input.decision === "dismissed") return null;
  if (input.decision === "accepted") return 0;
  if (!input.result) return Number(((input.edited_fields?.length ?? 0) / 4).toFixed(4));
  try {
    const snapshot = Schema.decodeUnknownSync(SuggestedSkillSnapshot)(JSON.parse(snapshotJson));
    const dimensions = [
      snapshot.name.trim() === input.result.name.trim() ? 0 : 1,
      snapshot.description.trim() === input.result.description.trim() ? 0 : 1,
      setDistance(snapshot.harnesses, input.result.harnesses),
      setDistance(
        snapshot.skills.map((skill) => skill.name),
        input.result.skills,
      ),
    ];
    return Number(
      (dimensions.reduce((total, value) => total + value, 0) / dimensions.length).toFixed(4),
    );
  } catch {
    return Number(((input.edited_fields?.length ?? 0) / 4).toFixed(4));
  }
}

export function loadSkillClassificationCorrections(
  sqlite: Database = getDb(),
): SkillClassificationCorrection[] {
  return getDrizzleDb(sqlite)
    .select()
    .from(skill_classification_corrections)
    .orderBy(asc(skill_classification_corrections.corrected_at))
    .all()
    .map((row) => ({
      ...row,
      category: row.category === null ? null : category(row.category),
      inferred_category: category(row.inferred_category),
    }));
}

export function loadSkillIntelligenceCalibration(
  sqlite: Database = getDb(),
): SkillIntelligenceCalibration {
  const db = getDrizzleDb(sqlite);
  const reviews = db
    .select({
      decision: skill_set_suggestion_reviews.decision,
      reason_code: skill_set_suggestion_reviews.reason_code,
      edit_distance: skill_set_suggestion_reviews.edit_distance,
      algorithm_version: skill_set_suggestion_reviews.algorithm_version,
      suggestion_json: skill_set_suggestion_snapshots.suggestion_json,
    })
    .from(skill_set_suggestion_reviews)
    .innerJoin(
      skill_set_suggestion_snapshots,
      eq(skill_set_suggestion_reviews.snapshot_id, skill_set_suggestion_snapshots.snapshot_id),
    )
    .all()
    .flatMap((row) => {
      try {
        const snapshot = Schema.decodeUnknownSync(SuggestedSkillSnapshot)(
          JSON.parse(row.suggestion_json),
        );
        return [
          {
            algorithm_version: row.algorithm_version,
            decision: decision(row.decision),
            reason_code: reasonCode(row.reason_code),
            edit_distance: row.edit_distance,
            evidence_score: snapshot.confidence,
          },
        ];
      } catch {
        return [];
      }
    });
  return calibrateSkillIntelligence({
    algorithmVersion: SKILL_INTELLIGENCE_ALGORITHM_VERSION,
    reviews,
    corrections: loadSkillClassificationCorrections(sqlite),
  });
}

export function loadSkillIntelligenceFeedback(
  sqlite: Database = getDb(),
): SkillIntelligenceFeedbackState {
  const db = getDrizzleDb(sqlite);
  const classificationOverrides = db
    .select()
    .from(skill_classification_overrides)
    .all()
    .map(
      (row): SkillClassificationOverride => ({
        ...row,
        category: category(row.category),
        inferred_category: category(row.inferred_category),
      }),
    );
  const suggestionReviews = db
    .select()
    .from(skill_set_suggestion_reviews)
    .orderBy(desc(skill_set_suggestion_reviews.reviewed_at))
    .all()
    .map(
      (row): SkillSetSuggestionReview => ({
        review_id: row.review_id,
        suggestion_id: row.suggestion_id,
        evidence_fingerprint: row.evidence_fingerprint,
        decision: decision(row.decision),
        reason_code: reasonCode(row.reason_code),
        reason: row.reason,
        resulting_set_id: row.resulting_set_id,
        resulting_set_revision_hash: row.resulting_set_revision_hash,
        edited_fields: [...parseReviewResult(row.result_json).edited_fields],
        edit_distance: row.edit_distance,
        algorithm_version: row.algorithm_version,
        reviewed_at: row.reviewed_at,
      }),
    );
  return {
    classificationOverrides,
    suggestionReviews,
    calibration: loadSkillIntelligenceCalibration(sqlite),
  };
}

export function setSkillClassificationOverride(
  input: SetSkillClassificationOverrideInput,
  sqlite: Database = getDb(),
  now = new Date(),
): SkillClassificationOverrideReceipt {
  const skillId = input.skill_id.trim().toLowerCase();
  const skillName = input.skill_name.trim();
  if (!skillId || !skillName) {
    throw new SkillIntelligenceFeedbackError(
      "INVALID_FEEDBACK",
      "A skill ID and skill name are required to classify a skill.",
    );
  }
  const updatedAt = now.toISOString();
  const db = getDrizzleDb(sqlite);
  const correctionId = `correction-${feedbackId(
    `${skillId}\u0000${updatedAt}\u0000${input.category ?? "inferred"}`,
  )}`;
  db.insert(skill_classification_corrections)
    .values({
      correction_id: correctionId,
      skill_id: skillId,
      skill_name: skillName,
      category: input.category,
      inferred_category: category(input.inferred_category),
      reason: input.reason?.trim() || null,
      algorithm_version: SKILL_INTELLIGENCE_ALGORITHM_VERSION,
      corrected_at: updatedAt,
    })
    .onConflictDoNothing()
    .run();
  if (input.category === null) {
    db.delete(skill_classification_overrides)
      .where(eq(skill_classification_overrides.skill_id, skillId))
      .run();
    return { skill_id: skillId, category: null, source: "inferred", updated_at: updatedAt };
  }
  const selectedCategory = category(input.category);
  const inferredCategory = category(input.inferred_category);

  db.insert(skill_classification_overrides)
    .values({
      skill_id: skillId,
      skill_name: skillName,
      category: selectedCategory,
      inferred_category: inferredCategory,
      reason: input.reason?.trim() || null,
      algorithm_version: SKILL_INTELLIGENCE_ALGORITHM_VERSION,
      created_at: updatedAt,
      updated_at: updatedAt,
    })
    .onConflictDoUpdate({
      target: skill_classification_overrides.skill_id,
      set: {
        skill_name: skillName,
        category: selectedCategory,
        inferred_category: inferredCategory,
        reason: input.reason?.trim() || null,
        algorithm_version: SKILL_INTELLIGENCE_ALGORITHM_VERSION,
        updated_at: updatedAt,
      },
    })
    .run();
  return { skill_id: skillId, category: selectedCategory, source: "human", updated_at: updatedAt };
}

export function persistSkillSetSuggestionSnapshots(
  sqlite: Database,
  report: SkillIntelligenceSnapshotReport,
): void {
  const db = getDrizzleDb(sqlite);
  for (const suggestion of report.suggestions) {
    const id = snapshotId(suggestion.suggestion_id, suggestion.evidence_fingerprint);
    db.insert(skill_set_suggestion_snapshots)
      .values({
        snapshot_id: id,
        suggestion_id: suggestion.suggestion_id,
        evidence_fingerprint: suggestion.evidence_fingerprint,
        pattern: suggestion.pattern,
        algorithm_version: report.algorithm_version,
        evidence_version: report.evidence_version,
        suggestion_json: JSON.stringify(suggestion),
        generated_at: report.generated_at,
        first_seen_at: report.generated_at,
        last_seen_at: report.generated_at,
      })
      // Evidence fingerprints define immutable snapshots. A repeat report with the same
      // evidence must not churn last_seen_at, SQLite's WAL, or report cache watermarks.
      .onConflictDoNothing({ target: skill_set_suggestion_snapshots.snapshot_id })
      .run();
  }
}

export function reviewSkillSetSuggestion(
  input: ReviewSkillSetSuggestionInput,
  sqlite: Database = getDb(),
  now = new Date(),
): SkillSetSuggestionReview {
  const suggestionId = input.suggestion_id.trim();
  const fingerprint = input.evidence_fingerprint.trim();
  if (!suggestionId || !fingerprint) {
    throw new SkillIntelligenceFeedbackError(
      "INVALID_FEEDBACK",
      "A suggestion ID and evidence fingerprint are required.",
    );
  }
  const selectedDecision = decision(input.decision);
  const selectedReasonCode = reasonCode(input.reason_code);
  const validReason =
    (selectedDecision === "accepted" && selectedReasonCode === "accepted_as_suggested") ||
    (selectedDecision === "edited" && selectedReasonCode === "edited_before_creation") ||
    (selectedDecision === "dismissed" &&
      selectedReasonCode !== "accepted_as_suggested" &&
      selectedReasonCode !== "edited_before_creation");
  if (!validReason) {
    throw new SkillIntelligenceFeedbackError(
      "INVALID_FEEDBACK",
      "The suggestion review reason does not match its decision.",
    );
  }
  const db = getDrizzleDb(sqlite);
  const id = snapshotId(suggestionId, fingerprint);
  const snapshot = db
    .select()
    .from(skill_set_suggestion_snapshots)
    .where(
      and(
        eq(skill_set_suggestion_snapshots.snapshot_id, id),
        eq(skill_set_suggestion_snapshots.suggestion_id, suggestionId),
        eq(skill_set_suggestion_snapshots.evidence_fingerprint, fingerprint),
      ),
    )
    .get();
  if (!snapshot) {
    throw new SkillIntelligenceFeedbackError(
      "STALE_SUGGESTION",
      "This suggestion is no longer current. Refresh the recommendations before reviewing it.",
    );
  }

  const reviewedAt = now.toISOString();
  const reviewId = `review-${feedbackId(`${id}\u0000${selectedDecision}`)}`;
  const reason = input.reason?.trim() || null;
  const resultingSetId = input.resulting_set_id?.trim() || null;
  const resultingSetRevisionHash = input.resulting_set_revision_hash?.trim() || null;
  const editDistance = normalizedEditDistance(snapshot.suggestion_json, input);
  const resultJson = JSON.stringify(
    ReviewResult.make({
      edited_fields: input.edited_fields ?? [],
      ...(input.result ? { result: input.result } : {}),
    }),
  );
  db.insert(skill_set_suggestion_reviews)
    .values({
      review_id: reviewId,
      snapshot_id: id,
      suggestion_id: suggestionId,
      evidence_fingerprint: fingerprint,
      decision: selectedDecision,
      reason_code: selectedReasonCode,
      reason,
      resulting_set_id: resultingSetId,
      resulting_set_revision_hash: resultingSetRevisionHash,
      result_json: resultJson,
      edit_distance: editDistance,
      algorithm_version: snapshot.algorithm_version,
      reviewed_at: reviewedAt,
    })
    .onConflictDoUpdate({
      target: [skill_set_suggestion_reviews.snapshot_id, skill_set_suggestion_reviews.decision],
      set: {
        reason_code: selectedReasonCode,
        reason,
        resulting_set_id: resultingSetId,
        resulting_set_revision_hash: resultingSetRevisionHash,
        result_json: resultJson,
        edit_distance: editDistance,
        reviewed_at: reviewedAt,
      },
    })
    .run();

  return {
    review_id: reviewId,
    suggestion_id: suggestionId,
    evidence_fingerprint: fingerprint,
    decision: selectedDecision,
    reason_code: selectedReasonCode,
    reason,
    resulting_set_id: resultingSetId,
    resulting_set_revision_hash: resultingSetRevisionHash,
    edited_fields: input.edited_fields ?? [],
    edit_distance: editDistance,
    algorithm_version: snapshot.algorithm_version,
    reviewed_at: reviewedAt,
  };
}
