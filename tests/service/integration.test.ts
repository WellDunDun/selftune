import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { renderBadgeSvg } from "../../cli/selftune/badge/badge-svg.js";
import { aggregatedToBadgeData } from "../../service/aggregation/compute-badge.js";
import { aggregateSkillData } from "../../service/aggregation/aggregate.js";
import { Store } from "../../service/storage/store.js";
import { validateBundle, extractSkillName } from "../../service/validation/validate-bundle.js";

const TEST_DB = join(import.meta.dir, "../../.test-data/test-integration.db");

describe("Full submit -> badge flow", () => {
  let store: Store;

  const bundle = {
    schema_version: "1.1" as const,
    skill_name: "integration-skill",
    contributor_id: "int-test-uuid",
    created_at: "2026-01-15T00:00:00Z",
    selftune_version: "0.1.4",
    agent_type: "claude_code",
    sanitization_level: "conservative" as const,
    positive_queries: [{ query: "test", invocation_type: "explicit", source: "test" }],
    eval_entries: [{ query: "test", should_trigger: true }],
    grading_summary: { total_sessions: 20, graded_sessions: 20, average_pass_rate: 0.90, expectation_count: 40 },
    evolution_summary: null,
    session_metrics: { total_sessions: 20, avg_assistant_turns: 5, avg_tool_calls: 10, avg_errors: 0, top_tools: [] },
  };

  beforeAll(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    store = new Store(TEST_DB);
  });

  afterAll(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
    }
  });

  it("end-to-end: validate -> store -> aggregate -> badge SVG", () => {
    // 1. Validate
    const validation = validateBundle(bundle);
    expect(validation.valid).toBe(true);

    // 2. Extract skill name
    const skillName = extractSkillName(bundle as Record<string, unknown>);
    expect(skillName).toBe("integration-skill");

    // 3. Store
    const id = store.insertSubmission(
      skillName,
      bundle.contributor_id,
      JSON.stringify(bundle),
      "test-ip-hash",
    );
    expect(id).toBeGreaterThan(0);

    // 4. Aggregate
    const submissions = store.getSubmissionsBySkill(skillName);
    const aggregated = aggregateSkillData(skillName, submissions);
    expect(aggregated.weighted_pass_rate).toBeCloseTo(0.90, 2);
    expect(aggregated.status).toBe("HEALTHY");
    store.upsertAggregation(aggregated);

    // 5. Read aggregation back
    const cached = store.getAggregation(skillName);
    expect(cached).not.toBeNull();
    expect(cached!.weighted_pass_rate).toBeCloseTo(0.90, 2);

    // 6. Convert to badge data
    const badgeData = aggregatedToBadgeData(cached!);
    expect(badgeData.color).toBe("#4c1"); // green
    expect(badgeData.message).toContain("90%");

    // 7. Render SVG
    const svg = renderBadgeSvg(badgeData);
    expect(svg).toContain("<svg");
    expect(svg).toContain("90%");
  });
});
