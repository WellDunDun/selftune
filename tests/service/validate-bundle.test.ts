import { describe, expect, it } from "bun:test";
import { extractSkillName, validateBundle } from "../../service/validation/validate-bundle.js";

describe("validateBundle", () => {
  const validBundle = {
    schema_version: "1.0",
    contributor_id: "test-uuid",
    created_at: "2026-01-01T00:00:00Z",
    selftune_version: "0.1.4",
    agent_type: "claude_code",
    sanitization_level: "conservative",
    positive_queries: [{ query: "test query", invocation_type: "explicit", source: "skill_log" }],
    eval_entries: [{ query: "test", should_trigger: true }],
    grading_summary: null,
    evolution_summary: null,
    session_metrics: { total_sessions: 1, avg_assistant_turns: 5, avg_tool_calls: 10, avg_errors: 0, top_tools: [] },
  };

  it("validates a correct bundle", () => {
    const result = validateBundle(validBundle);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects non-object payload", () => {
    const result = validateBundle("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Payload must be a JSON object");
  });

  it("rejects invalid schema_version", () => {
    const result = validateBundle({ ...validBundle, schema_version: "2.0" });
    expect(result.valid).toBe(false);
  });

  it("rejects missing contributor_id", () => {
    const { contributor_id, ...noId } = validBundle;
    const result = validateBundle(noId);
    expect(result.valid).toBe(false);
  });

  it("rejects invalid sanitization_level", () => {
    const result = validateBundle({ ...validBundle, sanitization_level: "invalid" });
    expect(result.valid).toBe(false);
  });

  it("rejects oversized positive_queries", () => {
    const queries = Array.from({ length: 1001 }, (_, i) => ({ query: `q${i}`, invocation_type: "explicit", source: "test" }));
    const result = validateBundle({ ...validBundle, positive_queries: queries });
    expect(result.valid).toBe(false);
  });

  it("accepts schema 1.1 with skill_name", () => {
    const result = validateBundle({ ...validBundle, schema_version: "1.1", skill_name: "my-skill" });
    expect(result.valid).toBe(true);
  });

  it("rejects non-string skill_name in 1.1", () => {
    const result = validateBundle({ ...validBundle, schema_version: "1.1", skill_name: 123 });
    expect(result.valid).toBe(false);
  });
});

describe("extractSkillName", () => {
  it("returns skill_name for 1.1 bundles", () => {
    expect(extractSkillName({ schema_version: "1.1", skill_name: "my-skill" })).toBe("my-skill");
  });

  it("returns 'selftune' for 1.0 bundles", () => {
    expect(extractSkillName({ schema_version: "1.0" })).toBe("selftune");
  });

  it("returns 'selftune' for 1.1 without skill_name", () => {
    expect(extractSkillName({ schema_version: "1.1" })).toBe("selftune");
  });
});
