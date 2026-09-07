import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  queryGradingResults,
  queryImprovementSignals,
  queryReplayEntryResults,
  queryReplayRegressions,
} from "../../packages/runtime/localdb/queries/monitoring.js";
import {
  getCronRunsByJob,
  getRecentCronRuns,
} from "../../packages/runtime/localdb/queries/cron.js";
import {
  getExecutionMetrics,
  getSessionCommits,
  getSkillCommitSummary,
} from "../../packages/runtime/localdb/queries/execution.js";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => {
  db.close();
});

describe("monitoring query contracts", () => {
  test("maps nullable signal fields to absent domain values", () => {
    db.run(
      "INSERT INTO improvement_signals (timestamp, session_id, query, signal_type) VALUES (?, ?, ?, ?)",
      ["2026-09-05", "session", "help", "correction"],
    );
    expect(queryImprovementSignals(db)).toEqual([
      {
        timestamp: "2026-09-05",
        session_id: "session",
        query: "help",
        signal_type: "correction",
        mentioned_skill: undefined,
        consumed: false,
        consumed_at: undefined,
        consumed_by_run: undefined,
      },
    ]);
    expect(queryImprovementSignals(db, true)).toEqual([]);
  });

  test("converts stored replay flags and filters by proposal and phase", () => {
    const insert = db.prepare(
      "INSERT INTO replay_entry_results (proposal_id, skill_name, validation_mode, phase, query, should_trigger, triggered, passed) VALUES (?, 'marketing', 'judge', ?, 'write copy', 1, ?, ?)",
    );
    insert.run("p1", "before", 1, 1);
    insert.run("p1", "after", 0, 0);
    insert.run("p2", "after", 1, 1);
    expect(queryReplayEntryResults(db, "p1")).toHaveLength(2);
    expect(queryReplayEntryResults(db, "p1", "after")).toEqual([
      {
        id: 2,
        proposal_id: "p1",
        skill_name: "marketing",
        validation_mode: "judge",
        phase: "after",
        query: "write copy",
        should_trigger: true,
        triggered: false,
        passed: false,
        evidence: null,
      },
    ]);
    expect(queryReplayRegressions(db, "p1")).toEqual([
      { query: "write copy", skill_name: "marketing", before_passed: true, after_passed: false },
    ]);
    expect(queryReplayRegressions(db, "p2")).toEqual([]);
  });

  test("keeps absent grading measurements null", () => {
    db.run(
      "INSERT INTO grading_results (grading_id, session_id, skill_name, graded_at) VALUES ('grade', 'session', 'marketing', '2026-09-05')",
    );
    expect(queryGradingResults(db)[0]).toMatchObject({
      grading_id: "grade",
      pass_rate: null,
      mean_score: null,
      total_count: null,
      execution_metrics_json: null,
    });
  });

  test("orders and bounds job history without mixing jobs", () => {
    const insert = db.prepare(
      "INSERT INTO cron_runs (job_name, started_at, elapsed_ms, status) VALUES (?, ?, 3, 'ok')",
    );
    insert.run("sync", "2026-09-04");
    insert.run("sync", "2026-09-05");
    insert.run("improve", "2026-09-06");
    expect(getRecentCronRuns(db, 1).map((row) => row.job_name)).toEqual(["improve"]);
    expect(getCronRunsByJob(db, "sync", 1)[0]).toMatchObject({
      started_at: "2026-09-05",
      metrics_json: null,
      error: null,
    });
    expect(getCronRunsByJob(db, "missing")).toEqual([]);
  });

  test("returns empty aggregates for missing sessions and skills", () => {
    expect(getExecutionMetrics(db, ["missing"])).toEqual(getExecutionMetrics(db, []));
    expect(getSessionCommits(db, "missing")).toEqual([]);
    expect(getSkillCommitSummary(db, "missing")).toEqual({
      total_commits: 0,
      unique_branches: 0,
      recent_commits: [],
    });
  });
});
