import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";

import { _setTestDb, openDb } from "../../packages/runtime/localdb/db.js";
import {
  writeGradingBaseline,
  type GradingBaselineInput,
} from "../../packages/runtime/localdb/direct-write.js";
import {
  queryGradingBaseline,
  queryGradeRegression,
  queryRecentGradingResults,
} from "../../packages/runtime/localdb/queries.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  _setTestDb(db);
});

afterEach(() => {
  _setTestDb(null);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseline(overrides: Partial<GradingBaselineInput> = {}): GradingBaselineInput {
  return {
    skill_name: "test-skill",
    proposal_id: null,
    measured_at: new Date().toISOString(),
    pass_rate: 0.85,
    mean_score: 4.2,
    sample_size: 10,
    grading_results_json: JSON.stringify(["sess-001", "sess-002"]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("grading baselines", () => {
  describe("writeGradingBaseline", () => {
    it("writes a baseline record successfully", () => {
      const result = writeGradingBaseline(makeBaseline());
      expect(result).toBe(true);

      // Verify it's in the DB
      const row = db
        .query("SELECT * FROM grading_baselines WHERE skill_name = ?")
        .get("test-skill") as Record<string, unknown>;
      expect(row).not.toBeNull();
      expect(row.pass_rate).toBe(0.85);
      expect(row.mean_score).toBe(4.2);
      expect(row.sample_size).toBe(10);
    });

    it("writes a baseline with a proposal_id", () => {
      const result = writeGradingBaseline(makeBaseline({ proposal_id: "prop-001" }));
      expect(result).toBe(true);

      const row = db
        .query("SELECT * FROM grading_baselines WHERE proposal_id = ?")
        .get("prop-001") as Record<string, unknown>;
      expect(row).not.toBeNull();
      expect(row.proposal_id).toBe("prop-001");
    });

    it("writes a baseline with null mean_score", () => {
      const result = writeGradingBaseline(makeBaseline({ mean_score: null }));
      expect(result).toBe(true);

      const row = db
        .query("SELECT * FROM grading_baselines WHERE skill_name = ?")
        .get("test-skill") as Record<string, unknown>;
      expect(row).not.toBeNull();
      expect(row.mean_score).toBeNull();
    });
  });

  describe("queryGradingBaseline", () => {
    it("returns the most recent baseline for a skill (pre-deploy)", () => {
      // Write two baselines for the same skill, different times
      writeGradingBaseline(
        makeBaseline({
          measured_at: "2026-03-01T10:00:00Z",
          pass_rate: 0.7,
        }),
      );
      writeGradingBaseline(
        makeBaseline({
          measured_at: "2026-03-02T10:00:00Z",
          pass_rate: 0.9,
        }),
      );

      const baseline = queryGradingBaseline(db, "test-skill");
      expect(baseline).not.toBeNull();
      expect(baseline!.pass_rate).toBe(0.9);
      expect(baseline!.measured_at).toBe("2026-03-02T10:00:00Z");
    });

    it("scopes to a specific proposal_id when provided", () => {
      writeGradingBaseline(
        makeBaseline({
          proposal_id: null,
          pass_rate: 0.7,
          measured_at: "2026-03-01T10:00:00Z",
        }),
      );
      writeGradingBaseline(
        makeBaseline({
          proposal_id: "prop-001",
          pass_rate: 0.9,
          measured_at: "2026-03-02T10:00:00Z",
        }),
      );

      const baseline = queryGradingBaseline(db, "test-skill", "prop-001");
      expect(baseline).not.toBeNull();
      expect(baseline!.pass_rate).toBe(0.9);
      expect(baseline!.proposal_id).toBe("prop-001");
    });

    it("returns null when no baseline exists", () => {
      const baseline = queryGradingBaseline(db, "nonexistent-skill");
      expect(baseline).toBeNull();
    });
  });

  describe("queryGradeRegression", () => {
    it("computes delta between pre-deploy and post-deploy baselines", () => {
      // Pre-deploy baseline (proposal_id = null)
      writeGradingBaseline(
        makeBaseline({
          proposal_id: null,
          pass_rate: 0.8,
          mean_score: 4.0,
          measured_at: "2026-03-01T10:00:00Z",
        }),
      );
      // Post-deploy baseline scoped to proposal
      writeGradingBaseline(
        makeBaseline({
          proposal_id: "prop-001",
          pass_rate: 0.6,
          mean_score: 3.0,
          measured_at: "2026-03-02T10:00:00Z",
        }),
      );

      const regression = queryGradeRegression(db, "test-skill", "prop-001");
      expect(regression).not.toBeNull();
      expect(regression!.before.pass_rate).toBe(0.8);
      expect(regression!.after.pass_rate).toBe(0.6);
      expect(regression!.delta_pass_rate).toBeCloseTo(-0.2, 5);
      expect(regression!.delta_mean_score).toBeCloseTo(-1.0, 5);
      expect(regression!.regressed).toBe(true);
    });

    it("computes delta between two proposal baselines", () => {
      writeGradingBaseline(
        makeBaseline({
          proposal_id: "prop-001",
          pass_rate: 0.8,
          mean_score: 4.0,
          measured_at: "2026-03-01T10:00:00Z",
        }),
      );
      writeGradingBaseline(
        makeBaseline({
          proposal_id: "prop-002",
          pass_rate: 0.95,
          mean_score: 4.8,
          measured_at: "2026-03-02T10:00:00Z",
        }),
      );

      const regression = queryGradeRegression(db, "test-skill", "prop-002", "prop-001");
      expect(regression).not.toBeNull();
      expect(regression!.delta_pass_rate).toBeCloseTo(0.15, 5);
      expect(regression!.regressed).toBe(false);
    });

    it("returns null when before baseline is missing", () => {
      writeGradingBaseline(
        makeBaseline({
          proposal_id: "prop-001",
          pass_rate: 0.8,
        }),
      );

      // No pre-deploy baseline exists
      const regression = queryGradeRegression(db, "test-skill", "prop-001");
      expect(regression).toBeNull();
    });

    it("returns null when after baseline is missing", () => {
      writeGradingBaseline(
        makeBaseline({
          proposal_id: null,
          pass_rate: 0.8,
        }),
      );

      // afterProposalId doesn't exist
      const regression = queryGradeRegression(db, "test-skill", "nonexistent");
      expect(regression).toBeNull();
    });
  });

  describe("queryRecentGradingResults", () => {
    it("returns recent grading results for a skill", () => {
      // Insert some grading_results directly
      db.run(
        `INSERT INTO grading_results
          (grading_id, session_id, skill_name, graded_at, pass_rate, mean_score, total_count, passed_count, failed_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["gr-001", "sess-001", "test-skill", "2026-03-01T10:00:00Z", 0.85, 4.2, 10, 8, 2],
      );
      db.run(
        `INSERT INTO grading_results
          (grading_id, session_id, skill_name, graded_at, pass_rate, mean_score, total_count, passed_count, failed_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["gr-002", "sess-002", "test-skill", "2026-03-02T10:00:00Z", 0.9, 4.5, 10, 9, 1],
      );

      const results = queryRecentGradingResults(db, "test-skill");
      expect(results).toHaveLength(2);
      // Most recent first
      expect(results[0].grading_id).toBe("gr-002");
      expect(results[1].grading_id).toBe("gr-001");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO grading_results
            (grading_id, session_id, skill_name, graded_at, pass_rate, total_count, passed_count, failed_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `gr-${i}`,
            `sess-${i}`,
            "test-skill",
            `2026-03-0${i + 1}T10:00:00Z`,
            0.8 + i * 0.05,
            10,
            8 + (i > 2 ? 1 : 0),
            2 - (i > 2 ? 1 : 0),
          ],
        );
      }

      const results = queryRecentGradingResults(db, "test-skill", 3);
      expect(results).toHaveLength(3);
    });

    it("returns empty array when no results exist", () => {
      const results = queryRecentGradingResults(db, "nonexistent-skill");
      expect(results).toEqual([]);
    });
  });
});
