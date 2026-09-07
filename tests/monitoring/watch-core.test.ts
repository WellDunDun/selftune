import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  buildWatchResult,
  evaluateWatch,
  type WatchDiagnostic,
} from "../../packages/runtime/monitoring/watch.js";

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function openTestDb(): Database {
  db = openDb(":memory:");
  return db;
}

describe("watch evaluation core", () => {
  test("uses the legacy audit-details fallback through the explicit database", () => {
    const testDb = openTestDb();
    testDb.run(
      `INSERT INTO evolution_audit
         (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "2026-03-01T12:00:00.000Z",
        "proposal-without-skill-prefix",
        null,
        "deployed",
        "Deployed fallback-skill proposal",
        JSON.stringify({ total: 10, passed: 8, failed: 2, pass_rate: 0.82 }),
      ],
    );

    const result = evaluateWatch(
      { skillName: "fallback-skill", skillPath: "/tmp/fallback-skill/SKILL.md" },
      {
        db: testDb,
        readPackageEvaluationArtifact: () => null,
        onDiagnostic: () => {},
      },
    );

    expect(result.proposalId).toBe("proposal-without-skill-prefix");
    expect(result.snapshot.baseline_pass_rate).toBe(0.82);
  });

  test("surfaces fail-open grade errors as structured diagnostics", () => {
    const testDb = openTestDb();
    testDb.run("DROP TABLE grading_baselines");
    const diagnostics: WatchDiagnostic[] = [];

    const evaluation = evaluateWatch(
      { skillName: "diagnostic-skill", skillPath: "/tmp/diagnostic-skill/SKILL.md" },
      {
        db: testDb,
        readPackageEvaluationArtifact: () => null,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );
    const result = buildWatchResult(evaluation, false);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("grade_watch_failed");
    expect(diagnostics[0]?.message).toContain('Grade watch failed for "diagnostic-skill"');
    expect(result.alert).toBeNull();
    expect(result.gradeAlert).toBeNull();
    expect(result.efficiencyAlert).toBeUndefined();
    expect(Object.hasOwn(result, "efficiencyAlert")).toBe(false);
    expect(Object.hasOwn(result, "efficiencyRegression")).toBe(false);
    expect(Object.hasOwn(result, "sync_result")).toBe(false);
    expect(Object.hasOwn(evaluation, "proposalId")).toBe(false);
  });

  test.each([
    { saved: "not-json", baseline: 0.5 },
    { saved: "null", baseline: 0.5 },
    { saved: "[]", baseline: 0.5 },
    { saved: "{}", baseline: 0.5 },
    { saved: '{"pass_rate":null}', baseline: 0.5 },
    { saved: '{"pass_rate":"0.8"}', baseline: 0.5 },
    { saved: '{"pass_rate":0}', baseline: 0 },
    { saved: '{"pass_rate":0.8,"total":"legacy"}', baseline: 0.8 },
  ])("decodes stored monitoring baseline $saved", ({ saved, baseline }) => {
    const testDb = openTestDb();
    testDb.run(
      `INSERT INTO evolution_audit
         (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "2026-03-01T12:00:00.000Z",
        "evo-decoded-1",
        "decoded",
        "deployed",
        "Deployed decoded",
        saved,
      ],
    );
    const result = evaluateWatch(
      { skillName: "decoded", skillPath: "/tmp/decoded/SKILL.md", enableGradeWatch: false },
      { db: testDb, readPackageEvaluationArtifact: () => null, onDiagnostic: () => {} },
    );
    expect(result.snapshot.baseline_pass_rate).toBe(baseline);
    expect(result.proposalId).toBe("evo-decoded-1");
    expect(Object.hasOwn(result, "proposalId")).toBe(true);
  });

  test("retains rollback guidance and explicit null commands in result composition", () => {
    const evaluation = evaluateWatch(
      { skillName: "example", skillPath: "/tmp/example/SKILL.md", enableGradeWatch: false },
      { db: openTestDb(), readPackageEvaluationArtifact: () => null, onDiagnostic: () => {} },
    );
    const regression = { ...evaluation, alert: "Observed regression" };
    const review = buildWatchResult(regression, false);
    expect(review.recommended_command).toBe(
      "selftune rollback --skill example --skill-path /tmp/example/SKILL.md",
    );
    expect(review.rolledBack).toBe(false);
    const rolledBack = buildWatchResult(regression, true);
    expect(rolledBack.recommended_command).toBeNull();
    expect(Object.hasOwn(rolledBack, "recommended_command")).toBe(true);
    expect(rolledBack.recommendation).toContain("Rolled back");
  });
});
