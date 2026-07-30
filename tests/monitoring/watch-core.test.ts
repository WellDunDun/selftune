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
  });
});
