import { describe, expect, test } from "bun:test";

import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  loadSkillClassificationCorrections,
  loadSkillIntelligenceCalibration,
  loadSkillIntelligenceFeedback,
  persistSkillSetSuggestionSnapshots,
  reviewSkillSetSuggestion,
  setSkillClassificationOverride,
} from "@selftune/runtime/skill-intelligence/feedback";
import type { SkillIntelligenceReport } from "@selftune/skill-intelligence";
import { exportSkillIntelligenceLearnedState } from "@selftune/runtime/skill-intelligence/learned-state";

function report(): SkillIntelligenceReport {
  return {
    algorithm_version: "skill-intelligence-v2-temporal-holdout",
    evidence_version: 2,
    generated_at: "2026-07-16T10:00:00.000Z",
    sessions_analyzed: 4,
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
      discovery_sessions: 3,
      held_out_sessions: 1,
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
            package_path: "/skills/research",
            category: "research",
            role: "Research",
            source_id: null,
            membership_score: 0.9,
          },
          {
            name: "writing",
            package_path: "/skills/writing",
            category: "writing_content",
            role: "Writing",
            source_id: null,
            membership_score: 0.9,
          },
        ],
        harnesses: ["codex"],
        project_root: null,
        evidence_state: "supported",
        confidence: 0.9,
        occurrence_count: 4,
        discovery_occurrence_count: 3,
        held_out_occurrence_count: 1,
        support: 0.8,
        held_out_support: 1,
        affinity: 0.75,
        held_out_affinity: 1,
        discovery_edge_coverage: null,
        held_out_edge_coverage: null,
        sequence_consistency: null,
        held_out_sequence_consistency: null,
        synergy_score: null,
        reason: "Repeated together.",
      },
    ],
    catalog_expansions: [],
    outcomes: [],
    trace_signals: [],
    execution_patterns: [],
  };
}

describe("skill intelligence feedback", () => {
  test("does not rewrite unchanged suggestion evidence snapshots", () => {
    const db = openDb(":memory:");
    try {
      const initial = report();
      persistSkillSetSuggestionSnapshots(db, initial);
      const changesAfterInitialWrite = db
        .query<{ total_changes: number }, []>("SELECT total_changes() AS total_changes")
        .get()?.total_changes;
      const snapshot = db
        .query<{ last_seen_at: string }, []>(
          "SELECT last_seen_at FROM skill_set_suggestion_snapshots LIMIT 1",
        )
        .get();

      persistSkillSetSuggestionSnapshots(db, initial);
      expect(
        db.query<{ total_changes: number }, []>("SELECT total_changes() AS total_changes").get()
          ?.total_changes,
      ).toBe(changesAfterInitialWrite);
      expect(
        db
          .query<{ last_seen_at: string }, []>(
            "SELECT last_seen_at FROM skill_set_suggestion_snapshots LIMIT 1",
          )
          .get()?.last_seen_at,
      ).toBe(snapshot?.last_seen_at);

      const changedEvidence = {
        ...initial,
        generated_at: "2026-07-16T11:00:00.000Z",
        suggestions: initial.suggestions.map((suggestion) => ({
          ...suggestion,
          evidence_fingerprint: "evidence-two",
        })),
      };
      persistSkillSetSuggestionSnapshots(db, changedEvidence);
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM skill_set_suggestion_snapshots",
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  test("stores and clears human category corrections through Drizzle", () => {
    const db = openDb(":memory:");
    try {
      const updated = setSkillClassificationOverride(
        {
          skill_id: "paper-finder",
          skill_name: "Paper Finder",
          category: "research",
          inferred_category: "general",
          reason: "This is a literature research workflow.",
        },
        db,
        new Date("2026-07-16T10:01:00.000Z"),
      );
      expect(updated).toMatchObject({
        skill_id: "paper-finder",
        category: "research",
        source: "human",
      });
      expect(loadSkillIntelligenceFeedback(db).classificationOverrides[0]).toMatchObject({
        category: "research",
        inferred_category: "general",
        reason: "This is a literature research workflow.",
      });

      setSkillClassificationOverride(
        {
          skill_id: "paper-finder",
          skill_name: "Paper Finder",
          category: null,
          inferred_category: "general",
        },
        db,
      );
      expect(loadSkillIntelligenceFeedback(db).classificationOverrides).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("records idempotent decisions against an immutable evidence snapshot", () => {
    const db = openDb(":memory:");
    try {
      const intelligence = report();
      persistSkillSetSuggestionSnapshots(db, intelligence);
      const input = {
        suggestion_id: "co-usage-example",
        evidence_fingerprint: "evidence-one",
        decision: "edited" as const,
        reason_code: "edited_before_creation" as const,
        reason: "Removed an unrelated skill.",
        resulting_set_id: "research-workflow",
        resulting_set_revision_hash: "revision-one",
        edited_fields: ["skills"],
        result: {
          name: "Research + Writing",
          description: "Recurring pair",
          harnesses: ["codex"],
          skills: ["research"],
        },
      };
      reviewSkillSetSuggestion(input, db, new Date("2026-07-16T10:02:00.000Z"));
      reviewSkillSetSuggestion(input, db, new Date("2026-07-16T10:03:00.000Z"));

      const state = loadSkillIntelligenceFeedback(db);
      expect(state.suggestionReviews).toHaveLength(1);
      expect(state.suggestionReviews[0]).toMatchObject({
        decision: "edited",
        reason_code: "edited_before_creation",
        resulting_set_id: "research-workflow",
        resulting_set_revision_hash: "revision-one",
        edited_fields: ["skills"],
        edit_distance: 0.125,
        reviewed_at: "2026-07-16T10:03:00.000Z",
      });
      expect(() =>
        reviewSkillSetSuggestion({ ...input, evidence_fingerprint: "missing-evidence" }, db),
      ).toThrow("no longer current");
      expect(() =>
        reviewSkillSetSuggestion(
          {
            ...input,
            decision: "dismissed",
            reason_code: "accepted_as_suggested",
          },
          db,
        ),
      ).toThrow("does not match");
    } finally {
      db.close();
    }
  });

  test("retains valid legacy review fields while omitting malformed neighbors", () => {
    const db = openDb(":memory:");
    try {
      persistSkillSetSuggestionSnapshots(db, report());
      reviewSkillSetSuggestion(
        {
          suggestion_id: "co-usage-example",
          evidence_fingerprint: "evidence-one",
          decision: "accepted",
          reason_code: "accepted_as_suggested",
        },
        db,
      );
      db.run("UPDATE skill_set_suggestion_reviews SET result_json = ?", [
        JSON.stringify(["skills", 42, null, { private_note: "must not be exported" }, "name"]),
      ]);
      expect(loadSkillIntelligenceFeedback(db).suggestionReviews[0].edited_fields).toEqual([
        "skills",
        "name",
      ]);
      const exported = exportSkillIntelligenceLearnedState(db);
      expect(JSON.parse(exported.reviews[0].result_json ?? "null")).toEqual(["skills", "name"]);
      expect(JSON.stringify(exported)).not.toContain("must not be exported");
    } finally {
      db.close();
    }
  });

  test("keeps an append-only versioned correction history and exposes calibration state", () => {
    const db = openDb(":memory:");
    try {
      setSkillClassificationOverride(
        {
          skill_id: "paper-finder",
          skill_name: "Paper Finder",
          category: "research",
          inferred_category: "general",
          reason: "Literature work",
        },
        db,
        new Date("2026-07-16T10:01:00.000Z"),
      );
      setSkillClassificationOverride(
        {
          skill_id: "paper-finder",
          skill_name: "Paper Finder",
          category: null,
          inferred_category: "research",
        },
        db,
        new Date("2026-07-16T10:02:00.000Z"),
      );

      expect(loadSkillClassificationCorrections(db)).toEqual([
        expect.objectContaining({
          skill_id: "paper-finder",
          category: "research",
          corrected_at: "2026-07-16T10:01:00.000Z",
        }),
        expect.objectContaining({
          skill_id: "paper-finder",
          category: null,
          corrected_at: "2026-07-16T10:02:00.000Z",
        }),
      ]);
      expect(loadSkillIntelligenceCalibration(db)).toMatchObject({
        status: "insufficient_evidence",
        category_corrections: 2,
        applied_min_evidence_score: 0,
      });
    } finally {
      db.close();
    }
  });
});
