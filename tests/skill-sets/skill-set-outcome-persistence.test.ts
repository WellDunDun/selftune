import { describe, expect, test } from "bun:test";

import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  loadSkillSetOutcomes,
  persistSkillSetOutcome,
  refreshSkillSetOutcomes,
} from "@selftune/runtime/skill-intelligence/outcome-store";
import type { SkillSetOutcome } from "@selftune/skill-intelligence/outcomes";

function outcome(status: SkillSetOutcome["status"]): SkillSetOutcome {
  const metric = {
    before: 0.5,
    after: 0.75,
    delta: 0.25,
    direction: "improved" as const,
    before_samples: 6,
    after_samples: 6,
  };
  return {
    outcome_id: "outcome-one",
    review_id: "review-one",
    receipt_id: "receipt-one",
    set_id: "research-workflow",
    algorithm_version: "skill-intelligence-v2-temporal-holdout",
    project_root: "/work/atlas",
    activated_at: "2026-07-10T00:00:00.000Z",
    measured_at: "2026-07-16T00:00:00.000Z",
    status,
    reason: "Observational comparison.",
    causal_claim: false,
    minimum_sessions: 5,
    before_session_count: 6,
    after_session_count: 6,
    metrics: {
      completion_quality: metric,
      error_rate: metric,
      trigger_coverage: metric,
      token_cost: metric,
      grading: metric,
    },
  };
}

describe("Skill Set outcome persistence", () => {
  test("upserts the latest measurement for one accepted-set activation", () => {
    const db = openDb(":memory:");
    try {
      db.run(
        `INSERT INTO skill_set_suggestion_snapshots
           (snapshot_id, suggestion_id, evidence_fingerprint, pattern, algorithm_version,
            evidence_version, suggestion_json, generated_at, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "snapshot-one",
          "suggestion-one",
          "evidence-one",
          "co_usage",
          "skill-intelligence-v2-temporal-holdout",
          2,
          "{}",
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      db.run(
        `INSERT INTO skill_set_suggestion_reviews
           (review_id, snapshot_id, suggestion_id, evidence_fingerprint, decision, reason_code,
            resulting_set_id, result_json, edit_distance, algorithm_version, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "review-one",
          "snapshot-one",
          "suggestion-one",
          "evidence-one",
          "accepted",
          "accepted_as_suggested",
          "research-workflow",
          "{}",
          0,
          "skill-intelligence-v2-temporal-holdout",
          "2026-07-01T00:00:00.000Z",
        ],
      );
      persistSkillSetOutcome(db, outcome("inconclusive"));
      persistSkillSetOutcome(db, {
        ...outcome("improved"),
        measured_at: "2026-07-17T00:00:00.000Z",
      });

      expect(loadSkillSetOutcomes(db)).toEqual([
        expect.objectContaining({
          outcome_id: "outcome-one",
          status: "improved",
          measured_at: "2026-07-17T00:00:00.000Z",
          causal_claim: false,
        }),
      ]);
    } finally {
      db.close();
    }
  });

  test("measures accepted suggestions after their resulting set is applied", () => {
    const db = openDb(":memory:");
    try {
      db.run(
        `INSERT INTO skill_set_suggestion_snapshots
           (snapshot_id, suggestion_id, evidence_fingerprint, pattern, algorithm_version,
            evidence_version, suggestion_json, generated_at, first_seen_at, last_seen_at)
         VALUES ('snapshot-two', 'suggestion-two', 'evidence-two', 'co_usage',
                 'skill-intelligence-v2-temporal-holdout', 2, '{}',
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
                 '2026-07-01T00:00:00.000Z')`,
      );
      db.run(
        `INSERT INTO skill_set_suggestion_reviews
           (review_id, snapshot_id, suggestion_id, evidence_fingerprint, decision, reason_code,
            resulting_set_id, result_json, edit_distance, algorithm_version, reviewed_at)
         VALUES ('review-two', 'snapshot-two', 'suggestion-two', 'evidence-two', 'accepted',
                 'accepted_as_suggested', 'research-workflow', '{}', 0,
                 'skill-intelligence-v2-temporal-holdout', '2026-07-01T00:00:00.000Z')`,
      );
      const sessions = Array.from({ length: 12 }, (_, index) => ({
        session_id: `session-${index + 1}`,
        timestamp: `2026-07-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`,
        cwd: "/work/atlas",
        completion_status: index < 6 ? ("failed" as const) : ("completed" as const),
        errors_encountered: index < 6 ? 2 : 0,
        input_tokens: index < 6 ? 800 : 500,
        output_tokens: index < 6 ? 200 : 100,
      }));
      const measured = refreshSkillSetOutcomes({
        db,
        reviews: [
          {
            review_id: "review-two",
            suggestion_id: "suggestion-two",
            evidence_fingerprint: "evidence-two",
            decision: "accepted",
            reason_code: "accepted_as_suggested",
            reason: null,
            resulting_set_id: "research-workflow",
            resulting_set_revision_hash: "revision",
            edited_fields: [],
            edit_distance: 0,
            algorithm_version: "skill-intelligence-v2-temporal-holdout",
            reviewed_at: "2026-07-01T00:00:00.000Z",
          },
        ],
        receipts: [
          {
            schema_version: 1,
            receipt_id: "receipt-two",
            set_id: "research-workflow",
            set_name: "Research workflow",
            set_revision_hash: "revision",
            project_root: "/work/atlas",
            status: "applied",
            operations: [],
            applied_at: "2026-07-08T00:00:00.000Z",
            rolled_back_at: null,
          },
          {
            schema_version: 1,
            receipt_id: "receipt-current-revision",
            set_id: "research-workflow",
            set_name: "Research workflow",
            set_revision_hash: "current-revision",
            project_root: "/work/atlas",
            status: "applied",
            operations: [],
            applied_at: "2026-07-09T00:00:00.000Z",
            rolled_back_at: null,
          },
        ],
        sets: [
          {
            schema_version: 1,
            set_id: "research-workflow",
            name: "Research workflow",
            description: "",
            harnesses: ["codex"],
            skills: [
              {
                name: "writing",
                content_hash: "current-hash",
                library_package_path: "/library/writing",
              },
            ],
            revision: 2,
            revision_hash: "current-revision",
            parent_revision_hash: "revision",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-15T00:00:00.000Z",
          },
        ],
        setRevisions: [
          {
            schema_version: 1,
            set_id: "research-workflow",
            name: "Research workflow",
            description: "",
            harnesses: ["codex"],
            skills: [
              {
                name: "research",
                content_hash: "hash",
                library_package_path: "/library/research",
              },
            ],
            revision: 1,
            revision_hash: "revision",
            parent_revision_hash: null,
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ],
        sessions,
        observations: sessions.map((session) => ({
          session_id: session.session_id,
          skill_name: "research",
          triggered: session.timestamp >= "2026-07-08T00:00:00.000Z",
        })),
        gradingResults: sessions.map((session) => ({
          session_id: session.session_id,
          skill_name: "research",
          pass_rate: session.timestamp >= "2026-07-08T00:00:00.000Z" ? 0.9 : 0.5,
        })),
        now: new Date("2026-07-20T00:00:00.000Z"),
      });

      expect(measured).toHaveLength(1);
      expect(measured[0]).toMatchObject({
        review_id: "review-two",
        receipt_id: "receipt-two",
        status: "improved",
      });
      expect(measured[0]?.metrics.trigger_coverage.after).toBe(1);
      expect(loadSkillSetOutcomes(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("keeps historical and synced aggregate outcomes without an active local receipt", () => {
    const db = openDb(":memory:");
    try {
      db.run(
        `INSERT INTO skill_set_suggestion_snapshots
           (snapshot_id, suggestion_id, evidence_fingerprint, pattern, algorithm_version,
            evidence_version, suggestion_json, generated_at, first_seen_at, last_seen_at)
         VALUES ('snapshot-one', 'suggestion-one', 'evidence-one', 'co_usage',
                 'skill-intelligence-v2-temporal-holdout', 2, '{}',
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
                 '2026-07-01T00:00:00.000Z')`,
      );
      db.run(
        `INSERT INTO skill_set_suggestion_reviews
           (review_id, snapshot_id, suggestion_id, evidence_fingerprint, decision, reason_code,
            resulting_set_id, result_json, edit_distance, algorithm_version, reviewed_at)
         VALUES ('review-one', 'snapshot-one', 'suggestion-one', 'evidence-one', 'accepted',
                 'accepted_as_suggested', 'research-workflow', '{}', 0,
                 'skill-intelligence-v2-temporal-holdout', '2026-07-01T00:00:00.000Z')`,
      );
      persistSkillSetOutcome(db, {
        ...outcome("inconclusive"),
        project_root: "[REMOTE_PROJECT]",
      });

      const refreshed = refreshSkillSetOutcomes({
        db,
        reviews: [],
        receipts: [
          {
            schema_version: 1,
            receipt_id: "receipt-one",
            set_id: "research-workflow",
            set_name: "Research workflow",
            set_revision_hash: "revision",
            project_root: "/work/atlas",
            status: "rolled_back",
            operations: [],
            applied_at: "2026-07-01T00:00:00.000Z",
            rolled_back_at: "2026-07-15T00:00:00.000Z",
          },
        ],
        sets: [],
        sessions: [],
        observations: [],
        gradingResults: [],
      });

      expect(loadSkillSetOutcomes(db)).toHaveLength(1);
      expect(refreshed).toEqual([
        expect.objectContaining({ outcome_id: "outcome-one", project_root: "[REMOTE_PROJECT]" }),
      ]);
    } finally {
      db.close();
    }
  });
});
