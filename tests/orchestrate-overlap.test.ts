/**
 * Tests for detectCrossSkillOverlap — cross-skill eval set overlap detection.
 *
 * This function is an internal helper in orchestrate.ts, exported only for testing.
 */

import { describe, expect, test } from "bun:test";
import { detectCrossSkillOverlap } from "../cli/selftune/orchestrate.js";
import type { QueryLogRecord, SkillUsageRecord } from "../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeSkillRecord(skillName: string, query: string): SkillUsageRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: "sess-001",
    skill_name: skillName,
    skill_path: `/skills/${skillName}/SKILL.md`,
    query,
    triggered: true,
    source: "claude_code_replay",
  };
}

function makeQueryRecord(query: string): QueryLogRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: "sess-001",
    query,
    source: "hook",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectCrossSkillOverlap", () => {
  test("detects overlap when two skills share >30% queries", () => {
    // Skill A: queries 1-5
    // Skill B: queries 3-7
    // Shared: 3, 4, 5 = 3 out of min(5,5) = 60% overlap
    const skillRecords: SkillUsageRecord[] = [
      makeSkillRecord("SkillA", "deploy the app"),
      makeSkillRecord("SkillA", "run the tests"),
      makeSkillRecord("SkillA", "check the logs"),
      makeSkillRecord("SkillA", "restart the server"),
      makeSkillRecord("SkillA", "update the config"),
      makeSkillRecord("SkillB", "check the logs"),
      makeSkillRecord("SkillB", "restart the server"),
      makeSkillRecord("SkillB", "update the config"),
      makeSkillRecord("SkillB", "scale the pods"),
      makeSkillRecord("SkillB", "monitor metrics"),
    ];

    const queryRecords: QueryLogRecord[] = [
      makeQueryRecord("deploy the app"),
      makeQueryRecord("run the tests"),
      makeQueryRecord("check the logs"),
      makeQueryRecord("restart the server"),
      makeQueryRecord("update the config"),
      makeQueryRecord("scale the pods"),
      makeQueryRecord("monitor metrics"),
    ];

    const candidates = [{ skill: "SkillA" }, { skill: "SkillB" }];
    const result = detectCrossSkillOverlap(candidates, skillRecords, queryRecords);

    expect(result.length).toBe(1);
    expect(result[0].skill_a).toBe("SkillA");
    expect(result[0].skill_b).toBe("SkillB");
    expect(result[0].overlap_pct).toBeGreaterThan(0.3);
    expect(result[0].shared_queries.length).toBe(3);
    expect(result[0].shared_queries).toContain("check the logs");
    expect(result[0].shared_queries).toContain("restart the server");
    expect(result[0].shared_queries).toContain("update the config");
  });

  test("returns empty array when skills have disjoint queries", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillRecord("SkillA", "deploy the app"),
      makeSkillRecord("SkillA", "run the tests"),
      makeSkillRecord("SkillA", "check the logs"),
      makeSkillRecord("SkillB", "scale the pods"),
      makeSkillRecord("SkillB", "monitor metrics"),
      makeSkillRecord("SkillB", "rotate secrets"),
    ];

    const queryRecords: QueryLogRecord[] = [
      makeQueryRecord("deploy the app"),
      makeQueryRecord("run the tests"),
      makeQueryRecord("check the logs"),
      makeQueryRecord("scale the pods"),
      makeQueryRecord("monitor metrics"),
      makeQueryRecord("rotate secrets"),
    ];

    const candidates = [{ skill: "SkillA" }, { skill: "SkillB" }];
    const result = detectCrossSkillOverlap(candidates, skillRecords, queryRecords);

    expect(result).toEqual([]);
  });

  test("returns empty array with empty candidates", () => {
    const result = detectCrossSkillOverlap([], [], []);
    expect(result).toEqual([]);
  });

  test("returns empty array with single candidate", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillRecord("SkillA", "deploy the app"),
    ];
    const queryRecords: QueryLogRecord[] = [
      makeQueryRecord("deploy the app"),
    ];

    const candidates = [{ skill: "SkillA" }];
    const result = detectCrossSkillOverlap(candidates, skillRecords, queryRecords);

    expect(result).toEqual([]);
  });

  test("caps shared_queries at 10 entries", () => {
    // Create two skills that share 15 queries
    const sharedQueries = Array.from({ length: 15 }, (_, i) => `shared query number ${i + 1}`);
    const skillRecords: SkillUsageRecord[] = [
      ...sharedQueries.map((q) => makeSkillRecord("SkillA", q)),
      ...sharedQueries.map((q) => makeSkillRecord("SkillB", q)),
    ];
    const queryRecords: QueryLogRecord[] = sharedQueries.map((q) => makeQueryRecord(q));

    const candidates = [{ skill: "SkillA" }, { skill: "SkillB" }];
    const result = detectCrossSkillOverlap(candidates, skillRecords, queryRecords);

    expect(result.length).toBe(1);
    expect(result[0].shared_queries.length).toBe(10);
    expect(result[0].overlap_pct).toBe(1.0); // 100% overlap
  });
});
