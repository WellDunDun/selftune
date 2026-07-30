import { beforeEach, describe, expect, test } from "bun:test";

import {
  buildCanonicalRecordsFromRollout,
  type ParsedRollout,
} from "@selftune/harness-codex/ingestors/codex-rollout";
import type { CanonicalRecord } from "@selftune/telemetry-contract";
import { _setTestDb, getDb, openDb } from "../../packages/runtime/localdb/db.js";
import { replaceCanonicalSessionSnapshotToDb } from "../../packages/runtime/localdb/direct-write.js";

function snapshot(sessionId: string, query: string, skillName: string): CanonicalRecord[] {
  const rollout: ParsedRollout = {
    timestamp: "2026-07-17T00:00:00.000Z",
    session_id: sessionId,
    source: "codex_rollout",
    rollout_path: `/tmp/${sessionId}.jsonl`,
    query,
    tool_calls: { command_execution: 1 },
    total_tool_calls: 1,
    bash_commands: [],
    skills_triggered: [skillName],
    skills_invoked: [skillName],
    skill_evidence: { [skillName]: "explicit" },
    assistant_turns: 1,
    errors_encountered: 0,
    input_tokens: 10,
    output_tokens: 5,
    transcript_chars: 100,
    cwd: "/tmp/project",
    transcript_path: `/tmp/${sessionId}.jsonl`,
    last_user_query: query,
  };
  return buildCanonicalRecordsFromRollout(rollout);
}

beforeEach(() => {
  _setTestDb(openDb(":memory:"));
});

describe("replaceCanonicalSessionSnapshotToDb", () => {
  test("rejects mixed sessions and live capture modes", () => {
    const first = snapshot("session-first", "old prompt", "old-skill");
    const secondSession = snapshot("session-second", "new prompt", "new-skill").find(
      (record) => record.record_kind === "session",
    );
    expect(secondSession).toBeDefined();
    expect(
      replaceCanonicalSessionSnapshotToDb([
        ...first.filter((record) => record.record_kind !== "session"),
        ...(secondSession ? [secondSession] : []),
      ]),
    ).toBe(false);

    const hookRecords: CanonicalRecord[] = first.map((record) => ({
      ...record,
      capture_mode: "hook",
    }));
    expect(replaceCanonicalSessionSnapshotToDb(hookRecords)).toBe(false);
    expect(getDb().query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  test("rolls back deletions when replacement insertion fails", () => {
    const sessionId = "session-rollback";
    expect(
      replaceCanonicalSessionSnapshotToDb(snapshot(sessionId, "old prompt", "old-skill")),
    ).toBe(true);
    const db = getDb();
    db.run(`
      CREATE TRIGGER fail_snapshot_fact
      BEFORE INSERT ON execution_facts
      WHEN NEW.session_id = '${sessionId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced snapshot failure');
      END
    `);

    expect(
      replaceCanonicalSessionSnapshotToDb(snapshot(sessionId, "new prompt", "new-skill")),
    ).toBe(false);
    expect(db.query("SELECT prompt_text FROM prompts WHERE session_id = ?").get(sessionId)).toEqual(
      { prompt_text: "old prompt" },
    );
    expect(
      db.query("SELECT skill_name FROM skill_invocations WHERE session_id = ?").get(sessionId),
    ).toEqual({ skill_name: "old-skill" });
    expect(
      db.query("SELECT COUNT(*) AS count FROM execution_facts WHERE session_id = ?").get(sessionId),
    ).toEqual({ count: 1 });
    expect(
      db.query("SELECT execution_fact_id FROM execution_facts WHERE session_id = ?").get(sessionId),
    ).toEqual({ execution_fact_id: `${sessionId}:execution-fact:codex-rollout` });
  });
});
