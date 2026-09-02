import { describe, expect, test } from "bun:test";

import type { QueryLogRecord, SessionTelemetryRecord, SkillUsageRecord } from "../types.js";
import { checkSkillSetCollisionReadiness } from "./collision-readiness.js";

function usage(skill: string, query: string, session = `${skill}-${query}`): SkillUsageRecord {
  return {
    timestamp: "2026-08-31T00:00:00.000Z",
    session_id: session,
    skill_name: skill,
    skill_path: `/skills/${skill}/SKILL.md`,
    query,
    triggered: true,
    source: "claude_code_replay",
  };
}

function query(value: string): QueryLogRecord {
  return {
    timestamp: "2026-08-31T00:00:00.000Z",
    session_id: `query-${value}`,
    query: value,
    source: "hook",
  };
}

function session(id: string, skills: string[], errors: number): SessionTelemetryRecord {
  return {
    timestamp: "2026-08-31T00:00:00.000Z",
    session_id: id,
    cwd: "/workspace",
    transcript_path: `/private/${id}.jsonl`,
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: skills,
    assistant_turns: 1,
    errors_encountered: errors,
    transcript_chars: 10,
    last_user_query: "private query",
  };
}

describe("checkSkillSetCollisionReadiness", () => {
  test("blocks rollout on trusted routing overlap", () => {
    const records = [
      usage("search", "find pricing advice"),
      usage("search", "compare auth vendors"),
      usage("model", "find pricing advice"),
      usage("model", "compare auth vendors"),
    ];
    const report = checkSkillSetCollisionReadiness({
      skillNames: ["search", "model"],
      telemetry: [],
      usage: records,
      queries: [query("find pricing advice"), query("compare auth vendors")],
      searchDirs: [],
    });

    expect(report.readiness).toBe("collision_risk");
    expect(report.blocking_evidence).toEqual([
      expect.objectContaining({
        kind: "trusted_routing_overlap",
        skill_a: "search",
        skill_b: "model",
      }),
    ]);
  });

  test("blocks rollout on observed composability conflict", () => {
    const telemetry = [
      session("a-alone", ["a"], 0),
      session("b-alone", ["b"], 0),
      session("both-1", ["a", "b"], 4),
      session("both-2", ["a", "b"], 4),
      session("both-3", ["a", "b"], 4),
    ];
    const report = checkSkillSetCollisionReadiness({
      skillNames: ["a", "b"],
      telemetry,
      usage: [
        usage("a", "route a"),
        usage("a", "route a two"),
        usage("b", "route b"),
        usage("b", "route b two"),
      ],
      queries: [query("route a"), query("route a two"), query("route b"), query("route b two")],
      searchDirs: [],
    });

    expect(report.readiness).toBe("collision_risk");
    expect(
      report.blocking_evidence.filter((item) => item.kind === "observed_runtime_conflict"),
    ).toHaveLength(1);
  });

  test("does not treat static similarity as collision proof", () => {
    const report = checkSkillSetCollisionReadiness({
      skillNames: ["search", "model"],
      telemetry: [],
      usage: [],
      queries: [],
      searchDirs: [],
    });

    expect(report.readiness).toBe("needs_evidence");
    expect(report.blocking_evidence).toEqual([]);
  });

  test("reports ready when routing evidence is distinct and no runtime conflict exists", () => {
    const records = [
      usage("search", "find pricing advice"),
      usage("search", "locate product strategy"),
      usage("model", "explain second order effects"),
      usage("model", "teach inversion thinking"),
    ];
    const report = checkSkillSetCollisionReadiness({
      skillNames: ["search", "model"],
      telemetry: [],
      usage: records,
      queries: records.map((record) => query(record.query)),
      searchDirs: [],
    });

    expect(report.readiness).toBe("ready");
    expect(report.blocking_evidence).toEqual([]);
    expect(report.evidence_gaps).toEqual([]);
  });
});
