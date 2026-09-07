import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OrchestrateRunSkillAction } from "@selftune/control-plane/orchestration";
import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  getOrchestrateRuns,
  queryEvolutionEvidence,
} from "../../packages/runtime/localdb/queries/evolution.js";
import {
  querySessionTelemetry,
  querySkillRecords,
} from "../../packages/runtime/localdb/queries/raw.js";
import {
  safeParseJson,
  safeParseJsonArray,
  safeParseToolCounts,
} from "../../packages/runtime/localdb/queries/json.js";

describe("stored JSON read boundaries", () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  test("string arrays, JSON objects, and tool counts validate their own contracts", () => {
    expect(safeParseJsonArray('["research"]')).toEqual(["research"]);
    expect(safeParseJsonArray('["research",42]')).toEqual([]);
    expect(safeParseJsonArray('"research"')).toEqual([]);
    expect(safeParseJson('{"custom":{"score":12}}')).toEqual({ custom: { score: 12 } });
    for (const value of ["[]", "42", "null", "{"]) expect(safeParseJson(value)).toBeNull();
    expect(safeParseToolCounts('{"Read":2}')).toEqual({ Read: 2 });
    for (const value of ['{"Read":"2"}', '{"Read":-1}', "[]"]) {
      expect(safeParseToolCounts(value)).toEqual({});
    }
  });

  test("telemetry normalizes nullable columns and rejects invalid JSON without rewriting it", () => {
    const counts = '{"Read":"two"}';
    db.run(
      `INSERT INTO session_telemetry(session_id, timestamp, tool_calls_json, skills_triggered_json)
      VALUES (?, ?, ?, ?)`,
      ["session", "2026-09-05", counts, "[42]"],
    );
    expect(querySessionTelemetry(db)[0]).toMatchObject({
      cwd: "",
      transcript_path: "",
      tool_calls: {},
      skills_triggered: [],
      total_tool_calls: 0,
      assistant_turns: 0,
      errors_encountered: 0,
    });
    expect(
      db
        .query<{ tool_calls_json: string }, []>("SELECT tool_calls_json FROM session_telemetry")
        .get()?.tool_calls_json,
    ).toBe(counts);
    expect(querySessionTelemetry(db, 0)).toEqual([]);
  });

  test("skill scope is decoded without staging a hosted upload", () => {
    db.run(`INSERT INTO sessions(session_id, raw_source_ref) VALUES (?, ?)`, ["session", "[]"]);
    db.run(
      `INSERT INTO skill_invocations(skill_invocation_id, session_id, skill_name, skill_scope, triggered)
      VALUES (?, ?, ?, ?, ?)`,
      ["invocation", "session", "research", "unsupported", 1],
    );
    expect(querySkillRecords(db)[0]).toMatchObject({ skill_name: "research", triggered: true });
    expect(querySkillRecords(db)[0]?.skill_scope).toBeUndefined();
    expect(querySkillRecords(db, 0)).toEqual([]);
  });

  test("raw evidence preserves valid historical metadata and rejects non-object JSON", () => {
    const validation = { improved: true, regressions: ["old query"], custom_metric: { score: 12 } };
    db.run(
      `INSERT INTO evolution_evidence(timestamp, proposal_id, skill_name, validation_json, eval_set_json)
      VALUES (?, ?, ?, ?, ?)`,
      ["2026-09-05", "proposal", "research", JSON.stringify(validation), "[42]"],
    );
    expect(queryEvolutionEvidence(db)[0]).toMatchObject({ validation, eval_set: [] });
    db.run("UPDATE evolution_evidence SET validation_json = ?", ["[]"]);
    expect(queryEvolutionEvidence(db)[0]?.validation).toBeNull();
  });

  test("orchestrate reports validate action metadata and never infer automatic approval", () => {
    db.run(
      `INSERT INTO orchestrate_runs(run_id, timestamp, elapsed_ms, dry_run, approval_mode,
      total_skills, evaluated, evolved, deployed, watched, skipped, skill_actions_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "run",
        "2026-09-05",
        1,
        0,
        "unsupported",
        1,
        1,
        0,
        0,
        0,
        1,
        '[{"skill":"research","action":"skip","reason":"quiet","deployed":"yes"}]',
      ],
    );
    expect(getOrchestrateRuns(db)[0]).toMatchObject({ approval_mode: "review", skill_actions: [] });
    const action = {
      skill: "research",
      action: "skip",
      reason: "quiet",
      deployed: false,
    } satisfies OrchestrateRunSkillAction;
    db.run("UPDATE orchestrate_runs SET skill_actions_json = ?", [JSON.stringify([action])]);
    expect(getOrchestrateRuns(db)[0]?.skill_actions).toEqual([action]);
  });
});
