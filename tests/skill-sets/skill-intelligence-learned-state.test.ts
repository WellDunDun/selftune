import { describe, expect, test } from "bun:test";

import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  exportSkillIntelligenceLearnedState,
  mergeSkillIntelligenceLearnedState,
} from "@selftune/runtime/skill-intelligence/learned-state";
import {
  loadSkillClassificationCorrections,
  loadSkillIntelligenceFeedback,
  persistSkillSetSuggestionSnapshots,
  reviewSkillSetSuggestion,
  setSkillClassificationOverride,
} from "@selftune/runtime/skill-intelligence/feedback";
import {
  loadSkillSetOutcomes,
  persistSkillSetOutcome,
} from "@selftune/runtime/skill-intelligence/outcome-store";
import type { SkillIntelligenceReport } from "@selftune/skill-intelligence";

function report(): SkillIntelligenceReport {
  return {
    algorithm_version: "skill-intelligence-v2-temporal-holdout",
    evidence_version: 2,
    generated_at: "2026-07-16T10:00:00.000Z",
    sessions_analyzed: 8,
    installed_skills: 2,
    classified_skills: 2,
    thresholds: {
      min_occurrences: 3,
      min_affinity: 0.35,
      holdout_ratio: 0.25,
      min_validation_occurrences: 2,
      min_evidence_score: 0,
    },
    validation: {
      ready: true,
      discovery_sessions: 6,
      held_out_sessions: 2,
      cutoff_at: "2026-07-15T00:00:00.000Z",
    },
    feedback: {
      classification_overrides: 0,
      suggestion_reviews: { accepted: 0, edited: 0, dismissed: 0 },
      calibration: {
        algorithm_version: "skill-intelligence-v2-temporal-holdout",
        status: "insufficient_evidence",
        minimum_labeled_reviews: 20,
        labeled_reviews: 0,
        positive_labels: 0,
        negative_labels: 0,
        total_reviews: 0,
        acceptance_rate: 0,
        exact_acceptance_rate: 0,
        edit_rate: 0,
        mean_edit_distance: null,
        dismissal_reasons: {},
        category_corrections: 0,
        applied_min_evidence_score: 0,
        balanced_accuracy: null,
      },
    },
    classifications: [],
    suggestions: [
      {
        suggestion_id: "co-usage-example",
        evidence_fingerprint: "evidence-one",
        name: "Research + Writing",
        description: "Recurring pair",
        pattern: "co_usage",
        skills: [
          {
            name: "research",
            package_path: "/Users/private/project/.agents/skills/research",
            category: "research",
            role: "Provides research and source validation.",
            source_id: "example/research-skills",
            membership_score: 0.9,
          },
          {
            name: "writing",
            package_path: "/Users/private/project/.agents/skills/writing",
            category: "writing_content",
            role: "Provides synthesis and editorial output.",
            source_id: "example/writing-skills",
            membership_score: 0.85,
          },
        ],
        harnesses: ["codex"],
        project_root: "/Users/private/project",
        evidence_state: "validated",
        confidence: 0.9,
        occurrence_count: 8,
        discovery_occurrence_count: 6,
        held_out_occurrence_count: 2,
        support: 0.8,
        held_out_support: 1,
        affinity: 0.75,
        held_out_affinity: 1,
        discovery_edge_coverage: 1,
        held_out_edge_coverage: 1,
        sequence_consistency: null,
        held_out_sequence_consistency: null,
        synergy_score: null,
        reason: "Aggregate evidence only.",
      },
    ],
    catalog_expansions: [],
    outcomes: [],
    trace_signals: [],
    execution_patterns: [],
  };
}

describe("Skill Intelligence learned-state portability", () => {
  test("exports legacy suggestion snapshots without evidence_state", () => {
    const source = openDb(":memory:");
    try {
      persistSkillSetSuggestionSnapshots(source, report());
      const stored = source
        .query<{ suggestion_json: string }, []>(
          "SELECT suggestion_json FROM skill_set_suggestion_snapshots LIMIT 1",
        )
        .get();
      if (!stored) throw new Error("Expected a persisted suggestion snapshot.");
      const legacy = JSON.parse(stored.suggestion_json) as Record<string, unknown>;
      for (const field of [
        "evidence_state",
        "discovery_occurrence_count",
        "held_out_occurrence_count",
        "held_out_support",
        "held_out_affinity",
        "held_out_sequence_consistency",
      ]) {
        delete legacy[field];
      }
      source
        .query("UPDATE skill_set_suggestion_snapshots SET suggestion_json = ?")
        .run(JSON.stringify(legacy));

      const payload = exportSkillIntelligenceLearnedState(source);
      const suggestion = JSON.parse(payload.snapshots[0]!.suggestion_json) as Record<
        string,
        unknown
      >;
      expect(suggestion.evidence_state).toBe("exploratory");
      expect(suggestion.discovery_occurrence_count).toBe(suggestion.occurrence_count);
      expect(suggestion.held_out_occurrence_count).toBe(0);
      expect(suggestion.held_out_support).toBeNull();
      expect(suggestion.held_out_affinity).toBeNull();
      expect(suggestion.held_out_sequence_consistency).toBeNull();
    } finally {
      source.close();
    }
  });

  test("round-trips aggregate learning without raw transcripts or local paths", () => {
    const source = openDb(":memory:");
    const destination = openDb(":memory:");
    try {
      setSkillClassificationOverride(
        {
          skill_id: "research",
          skill_name: "research",
          category: "research",
          inferred_category: "general",
          reason: "Corrected in /Users/private/project after session private-session-123",
        },
        source,
        new Date("2026-07-16T10:01:00.000Z"),
      );
      persistSkillSetSuggestionSnapshots(source, report());
      const review = reviewSkillSetSuggestion(
        {
          suggestion_id: "co-usage-example",
          evidence_fingerprint: "evidence-one",
          decision: "accepted",
          reason_code: "accepted_as_suggested",
          reason: "Accepted after reading /Users/private/transcripts/session.jsonl",
          resulting_set_id: "research-writing",
          resulting_set_revision_hash: "revision-one",
          edited_fields: [],
        },
        source,
        new Date("2026-07-16T10:02:00.000Z"),
      );
      persistSkillSetOutcome(source, {
        outcome_id: "outcome-one",
        review_id: review.review_id,
        receipt_id: "receipt-one",
        set_id: "research-writing",
        algorithm_version: report().algorithm_version,
        project_root: "/Users/private/project",
        activated_at: "2026-07-16T10:03:00.000Z",
        measured_at: "2026-07-20T10:03:00.000Z",
        status: "inconclusive",
        reason: "Aggregate observation; no causal claim.",
        causal_claim: false,
        minimum_sessions: 5,
        before_session_count: 3,
        after_session_count: 3,
        metrics: {
          completion_quality: {
            before: 0.5,
            after: 0.6,
            delta: 0.1,
            direction: "improved",
            before_samples: 3,
            after_samples: 3,
          },
          error_rate: {
            before: 0.5,
            after: 0.5,
            delta: 0,
            direction: "stable",
            before_samples: 3,
            after_samples: 3,
          },
          trigger_coverage: {
            before: 0.5,
            after: 0.7,
            delta: 0.2,
            direction: "improved",
            before_samples: 3,
            after_samples: 3,
          },
          token_cost: {
            before: 1_000,
            after: 900,
            delta: -100,
            direction: "improved",
            before_samples: 3,
            after_samples: 3,
          },
          grading: {
            before: null,
            after: null,
            delta: null,
            direction: "unavailable",
            before_samples: 0,
            after_samples: 0,
          },
        },
      });

      const payload = exportSkillIntelligenceLearnedState(
        source,
        new Date("2026-07-21T00:00:00.000Z"),
      );
      const encoded = JSON.stringify(payload);
      expect(encoded).not.toContain("/Users/private");
      expect(encoded).not.toContain("session.jsonl");
      expect(encoded).not.toContain("private-session-123");
      expect(encoded).not.toContain("transcript_path");

      const first = mergeSkillIntelligenceLearnedState(destination, payload);
      const second = mergeSkillIntelligenceLearnedState(destination, payload);
      expect(first).toMatchObject({
        overrides: 1,
        corrections: 1,
        snapshots: 1,
        reviews: 1,
        outcomes: 1,
      });
      expect(second).toEqual({
        overrides: 0,
        corrections: 0,
        snapshots: 0,
        reviews: 0,
        outcomes: 0,
      });
      expect(loadSkillIntelligenceFeedback(destination).classificationOverrides).toHaveLength(1);
      expect(loadSkillIntelligenceFeedback(destination).suggestionReviews).toHaveLength(1);
      expect(loadSkillClassificationCorrections(destination)).toHaveLength(1);
      expect(loadSkillSetOutcomes(destination)).toHaveLength(1);
      expect(loadSkillSetOutcomes(destination)[0]?.project_root).toBe("[REMOTE_PROJECT]");

      const firstStableExport = exportSkillIntelligenceLearnedState(source);
      const secondStableExport = exportSkillIntelligenceLearnedState(source);
      expect(secondStableExport).toEqual(firstStableExport);
      expect(firstStableExport.exported_at).toBe("2026-07-20T10:03:00.000Z");
    } finally {
      source.close();
      destination.close();
    }
  });
});
