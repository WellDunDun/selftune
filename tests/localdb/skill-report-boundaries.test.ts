import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { handleSkillReport } from "@selftune/local/routes/skill-report";
import { openDb } from "../../packages/runtime/localdb/db.js";

const decodeReport = Schema.decodeUnknownSync(
  Schema.Struct({
    selftune_stats: Schema.Struct({
      total_llm_calls: Schema.Number,
      total_elapsed_ms: Schema.Number,
      avg_elapsed_ms: Schema.Number,
      run_count: Schema.Number,
    }),
    watch_trust_score: Schema.NullOr(Schema.Number),
  }),
);

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
  db.run("INSERT INTO sessions (session_id) VALUES ('session')");
  db.run(`INSERT INTO skill_invocations (skill_invocation_id, session_id, skill_name, occurred_at, triggered)
    VALUES ('invocation', 'session', 'boundary-fixture', '2026-09-05', 1)`);
});
afterEach(() => db.close());

function seedActions(id: string, actions: string) {
  db.run(
    `INSERT INTO orchestrate_runs (run_id, timestamp, elapsed_ms, dry_run, approval_mode,
    total_skills, evaluated, evolved, deployed, watched, skipped, skill_actions_json)
    VALUES (?, '2026-09-05', 0, 0, 'auto', 1, 1, 0, 0, 0, 0, ?)`,
    [id, actions],
  );
}

describe("skill report persisted JSON boundaries", () => {
  test("keeps valid neighboring measurements without string concatenation or negative counts", async () => {
    seedActions(
      "mixed",
      JSON.stringify([
        null,
        { skill: "boundary-fixture", action: "evolve", elapsed_ms: "100", llm_calls: 2 },
        { skill: "boundary-fixture", action: "evolve", elapsed_ms: 20, llm_calls: -2 },
        { skill: "boundary-fixture", elapsed_ms: 10, llm_calls: 1 },
        { skill: "boundary-fixture", action: "watch", elapsed_ms: 999, llm_calls: 999 },
        { skill: "boundary-fixture", action: "skip", elapsed_ms: 999, llm_calls: 999 },
        { skill: "another-skill", action: "evolve", elapsed_ms: 999, llm_calls: 999 },
        { skill: "boundary-fixture", elapsed_ms: -1, llm_calls: 1.5 },
      ]),
    );
    seedActions("broken", '[{"skill":"boundary-fixture"');
    seedActions("wrong-root", JSON.stringify({ skill: "boundary-fixture", elapsed_ms: 999 }));
    const response = handleSkillReport(db, "boundary-fixture");
    expect(response.status).toBe(200);
    const report = decodeReport(await response.json());
    expect(report.selftune_stats).toEqual({
      total_llm_calls: 3,
      total_elapsed_ms: 30,
      avg_elapsed_ms: 10,
      run_count: 3,
    });
  });

  test.each([
    "{broken",
    "null",
    '{"watch":{"snapshot":{}}}',
    '{"watch":{"snapshot":{"skill_checks":"10"}}}',
  ])("does not turn malformed watch evidence into a trust score: %s", async (summary) => {
    db.run(
      "INSERT INTO package_evaluation_reports (skill_name, stored_at, summary_json) VALUES ('boundary-fixture', '2026-09-05', ?)",
      [summary],
    );
    const response = handleSkillReport(db, "boundary-fixture");
    expect(response.status).toBe(200);
    expect(decodeReport(await response.json()).watch_trust_score).toBeNull();
  });
});
