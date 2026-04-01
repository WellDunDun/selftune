import { describe, expect, test } from "bun:test";

import { analyzeSkillFamilyOverlap } from "../../cli/selftune/eval/family-overlap.js";
import type { QueryLogRecord, SkillUsageRecord } from "../../cli/selftune/types.js";

function makeSkillRecord(skillName: string, query: string): SkillUsageRecord {
  return {
    timestamp: new Date().toISOString(),
    session_id: `sess-${skillName}-${query}`,
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
    session_id: `query-${query}`,
    query,
    source: "hook",
  };
}

describe("analyzeSkillFamilyOverlap", () => {
  test("flags consolidation candidate for overlapping sibling family", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillRecord("sc-search", "find the best state change content on pricing strategy"),
      makeSkillRecord("sc-search", "search state change for jobs to be done examples"),
      makeSkillRecord("sc-search", "compare build vs buy for auth"),
      makeSkillRecord("sc-search", "show me the full details of jobs to be done"),
      makeSkillRecord("sc-model", "show me the full details of jobs to be done"),
      makeSkillRecord("sc-model", "find the best state change content on pricing strategy"),
      makeSkillRecord("sc-model", "search state change for jobs to be done examples"),
      makeSkillRecord("sc-model", "compare build vs buy for auth"),
      makeSkillRecord("sc-compare", "compare build vs buy for auth"),
      makeSkillRecord("sc-compare", "search state change for jobs to be done examples"),
      makeSkillRecord("sc-compare", "compare xano vs supabase"),
      makeSkillRecord("sc-compare", "find the best state change content on pricing strategy"),
    ];
    const queryRecords = [...new Set(skillRecords.map((record) => record.query))].map(
      makeQueryRecord,
    );

    const report = analyzeSkillFamilyOverlap(
      ["sc-search", "sc-model", "sc-compare"],
      skillRecords,
      queryRecords,
      { familyPrefix: "sc-", searchDirs: [] },
    );

    expect(report.consolidation_candidate).toBe(true);
    expect(report.overlap_count).toBeGreaterThanOrEqual(2);
    expect(report.refactor_proposal?.parent_skill_name).toBe("sc");
    expect(
      report.refactor_proposal?.internal_workflows.map((workflow) => workflow.workflow_name),
    ).toEqual(["search", "model", "compare"]);
  });

  test("keeps separate families separate when overlap is low", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillRecord("sc-search", "search state change for pricing strategy"),
      makeSkillRecord("sc-search", "find state change content about mental models"),
      makeSkillRecord("sc-model", "show me the full model for jobs to be done"),
      makeSkillRecord("sc-model", "explain the second-order thinking model in detail"),
      makeSkillRecord("sc-compare", "compare stripe vs paddle"),
      makeSkillRecord("sc-compare", "compare supabase vs firebase"),
    ];
    const queryRecords = [...new Set(skillRecords.map((record) => record.query))].map(
      makeQueryRecord,
    );

    const report = analyzeSkillFamilyOverlap(
      ["sc-search", "sc-model", "sc-compare"],
      skillRecords,
      queryRecords,
      { familyPrefix: "sc-", searchDirs: [] },
    );

    expect(report.consolidation_candidate).toBe(false);
    expect(report.pairs).toEqual([]);
    expect(report.refactor_proposal).toBeUndefined();
  });

  test("supports explicit parent skill override", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillRecord("sc-search", "shared query one"),
      makeSkillRecord("sc-search", "shared query two"),
      makeSkillRecord("sc-model", "shared query one"),
      makeSkillRecord("sc-model", "shared query two"),
      makeSkillRecord("sc-compare", "shared query one"),
      makeSkillRecord("sc-compare", "shared query two"),
    ];
    const queryRecords = [...new Set(skillRecords.map((record) => record.query))].map(
      makeQueryRecord,
    );

    const report = analyzeSkillFamilyOverlap(
      ["sc-search", "sc-model", "sc-compare"],
      skillRecords,
      queryRecords,
      {
        familyPrefix: "sc-",
        parentSkillName: "state-change",
        searchDirs: [],
      },
    );

    expect(report.refactor_proposal?.parent_skill_name).toBe("state-change");
  });

  test("reports low-signal families honestly", () => {
    const skillRecords: SkillUsageRecord[] = [
      makeSkillRecord("sc-setup", "install the state change cli"),
    ];
    const queryRecords = [makeQueryRecord("install the state change cli")];

    const report = analyzeSkillFamilyOverlap(
      ["sc-search", "sc-model", "sc-setup"],
      skillRecords,
      queryRecords,
      { familyPrefix: "sc-", searchDirs: [] },
    );

    expect(report.consolidation_candidate).toBe(false);
    expect(report.recommendation).toContain("Insufficient trusted telemetry");
    expect(
      report.rationale.some(
        (line) => line.includes("Only 0 sibling skills") || line.includes("Only 1 sibling skills"),
      ),
    ).toBe(true);
  });
});
