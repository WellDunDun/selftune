import { describe, expect, test } from "bun:test";
import { computeLastInsight, formatInsight } from "../../cli/selftune/last.js";
import type {
  QueryLogRecord,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTelemetry(overrides: Partial<SessionTelemetryRecord> = {}): SessionTelemetryRecord {
  return {
    timestamp: "2026-02-28T14:32:00Z",
    session_id: "a1b2c3d4",
    cwd: "/home/user/project",
    transcript_path: "/tmp/transcript.json",
    tool_calls: { Read: 5, Bash: 3 },
    total_tool_calls: 14,
    bash_commands: ["ls", "git status"],
    skills_triggered: ["Research", "Browser"],
    assistant_turns: 8,
    errors_encountered: 0,
    transcript_chars: 12000,
    last_user_query: "help me deploy",
    source: "test",
    ...overrides,
  };
}

function makeSkillRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    timestamp: "2026-02-28T14:32:00Z",
    session_id: "a1b2c3d4",
    skill_name: "Research",
    skill_path: "/skills/Research/SKILL.md",
    query: "research this topic",
    triggered: true,
    source: "test",
    ...overrides,
  };
}

function makeQueryRecord(overrides: Partial<QueryLogRecord> = {}): QueryLogRecord {
  return {
    timestamp: "2026-02-28T14:32:00Z",
    session_id: "a1b2c3d4",
    query: "research this topic",
    source: "test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeLastInsight
// ---------------------------------------------------------------------------

describe("computeLastInsight", () => {
  test("returns null when telemetry array is empty", () => {
    const result = computeLastInsight([], [], []);
    expect(result).toBeNull();
  });

  test("selects the most recent telemetry record by timestamp", () => {
    const older = makeTelemetry({
      session_id: "older-session",
      timestamp: "2026-02-27T10:00:00Z",
    });
    const newer = makeTelemetry({
      session_id: "newer-session",
      timestamp: "2026-02-28T14:32:00Z",
    });
    const result = computeLastInsight([older, newer], [], []);
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe("newer-session");
  });

  test("extracts unique triggered skill names for the session", () => {
    const telemetry = [makeTelemetry({ session_id: "sess-1" })];
    const skills = [
      makeSkillRecord({ session_id: "sess-1", skill_name: "Research", triggered: true }),
      makeSkillRecord({ session_id: "sess-1", skill_name: "Research", triggered: true }),
      makeSkillRecord({ session_id: "sess-1", skill_name: "Browser", triggered: true }),
      makeSkillRecord({ session_id: "sess-1", skill_name: "Deploy", triggered: false }),
      makeSkillRecord({ session_id: "other-sess", skill_name: "Ignored", triggered: true }),
    ];
    const result = computeLastInsight(telemetry, skills, []);
    expect(result).not.toBeNull();
    expect(result?.skillsTriggered.sort()).toEqual(["Browser", "Research"]);
  });

  test("detects unmatched queries for the session", () => {
    const telemetry = [makeTelemetry({ session_id: "sess-1" })];
    const skills = [
      makeSkillRecord({
        session_id: "sess-1",
        skill_name: "Research",
        triggered: true,
        query: "research this topic",
      }),
    ];
    const queries = [
      makeQueryRecord({ session_id: "sess-1", query: "research this topic" }),
      makeQueryRecord({ session_id: "sess-1", query: "how do I deploy to staging?" }),
      makeQueryRecord({ session_id: "sess-1", query: "fix the login bug" }),
      makeQueryRecord({ session_id: "other-sess", query: "unrelated query" }),
    ];
    const result = computeLastInsight(telemetry, skills, queries);
    expect(result).not.toBeNull();
    expect(result?.unmatchedQueries.sort()).toEqual([
      "fix the login bug",
      "how do I deploy to staging?",
    ]);
  });

  test("recommendation mentions unmatched queries when present", () => {
    const telemetry = [makeTelemetry({ session_id: "sess-1", errors_encountered: 0 })];
    const skills = [
      makeSkillRecord({ session_id: "sess-1", skill_name: "Research", triggered: true }),
    ];
    const queries = [
      makeQueryRecord({ session_id: "sess-1", query: "unmatched query 1" }),
      makeQueryRecord({ session_id: "sess-1", query: "unmatched query 2" }),
    ];
    const result = computeLastInsight(telemetry, skills, queries);
    expect(result).not.toBeNull();
    expect(result?.recommendation).toBe(
      "2 queries had no skill match. Run 'selftune eval generate --list-skills' to investigate.",
    );
  });

  test("recommendation mentions errors when errors > 0 but no unmatched", () => {
    const telemetry = [makeTelemetry({ session_id: "sess-1", errors_encountered: 3 })];
    const skills = [
      makeSkillRecord({
        session_id: "sess-1",
        skill_name: "Research",
        triggered: true,
        query: "matched query",
      }),
    ];
    const queries = [makeQueryRecord({ session_id: "sess-1", query: "matched query" })];
    const result = computeLastInsight(telemetry, skills, queries);
    expect(result).not.toBeNull();
    expect(result?.recommendation).toBe("3 errors encountered. Check logs for details.");
  });

  test("recommendation is positive when no unmatched and no errors", () => {
    const telemetry = [makeTelemetry({ session_id: "sess-1", errors_encountered: 0 })];
    const skills = [
      makeSkillRecord({
        session_id: "sess-1",
        skill_name: "Research",
        triggered: true,
        query: "matched query",
      }),
    ];
    const queries = [makeQueryRecord({ session_id: "sess-1", query: "matched query" })];
    const result = computeLastInsight(telemetry, skills, queries);
    expect(result).not.toBeNull();
    expect(result?.recommendation).toBe("All queries matched skills. System is operating well.");
  });
});

// ---------------------------------------------------------------------------
// formatInsight
// ---------------------------------------------------------------------------

describe("formatInsight", () => {
  test("output contains session ID and formatted fields", () => {
    const insight = {
      sessionId: "a1b2c3d4",
      timestamp: "2026-02-28T14:32:00Z",
      skillsTriggered: ["Research", "Browser"],
      unmatchedQueries: ["how do I deploy to staging?", "fix the login bug", "run the tests"],
      errors: 0,
      toolCalls: 14,
      recommendation:
        "3 queries had no skill match. Run 'selftune eval generate --list-skills' to investigate.",
    };
    const output = formatInsight(insight);
    expect(output).toContain("a1b2c3d4");
    expect(output).toContain("Research");
    expect(output).toContain("Browser");
    expect(output).toContain("how do I deploy to staging?");
    expect(output).toContain("fix the login bug");
    expect(output).toContain("run the tests");
    expect(output).toContain("Errors:");
    expect(output).toContain("Tool calls:");
    expect(output).toContain("14");
    expect(output).toContain("selftune eval generate --list-skills");
  });

  test("output omits unmatched section when no unmatched queries", () => {
    const insight = {
      sessionId: "xyz-session",
      timestamp: "2026-02-28T14:32:00Z",
      skillsTriggered: ["Research"],
      unmatchedQueries: [],
      errors: 0,
      toolCalls: 5,
      recommendation: "All queries matched skills. System is operating well.",
    };
    const output = formatInsight(insight);
    expect(output).toContain("xyz-session");
    expect(output).toContain("Unmatched queries: 0");
    expect(output).not.toContain("\xB7");
  });
});
