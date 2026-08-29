import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { getTrayAttentionSummary } from "@selftune/runtime/localdb/queries";

let database: Database | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

describe("tray attention summary", () => {
  it("uses bounded aggregates for observed, pending, regressed, and rolled-back skills", () => {
    database = new Database(":memory:");
    database.run(`
      CREATE TABLE skill_invocations (
        skill_invocation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        occurred_at TEXT,
        skill_name TEXT NOT NULL,
        triggered INTEGER,
        matched_prompt_id TEXT,
        query TEXT,
        skill_path TEXT,
        capture_mode TEXT
      );
      CREATE TABLE prompts (
        prompt_id TEXT PRIMARY KEY,
        prompt_kind TEXT,
        prompt_text TEXT
      );
      CREATE TABLE evolution_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        skill_name TEXT,
        action TEXT NOT NULL,
        details TEXT,
        eval_snapshot_json TEXT
      );
    `);

    const insertInvocation = database.prepare(
      `INSERT INTO skill_invocations
       (skill_invocation_id, session_id, occurred_at, skill_name, triggered)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 5; index++) {
      insertInvocation.run(
        `review-${index}`,
        `session-${index}`,
        `2026-08-0${index + 1}T00:00:00.000Z`,
        "review-skill",
        index === 0 ? 0 : 1,
      );
    }
    insertInvocation.run(
      "rollback-1",
      "session-rollback",
      "2026-08-06T00:00:00.000Z",
      "rollback-skill",
      1,
    );
    insertInvocation.run(
      "legacy:su:1",
      "session-legacy",
      "2026-08-06T00:00:00.000Z",
      "legacy-materialized-skill",
      0,
    );

    database.run(
      `INSERT INTO evolution_audit
       (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-08-06T01:00:00.000Z", "proposal-review", "review-skill", "created", "Awaiting review"],
    );
    database.run(
      `INSERT INTO evolution_audit
       (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      [
        "2026-08-06T02:00:00.000Z",
        "proposal-rollback",
        "rollback-skill",
        "rolled_back",
        "Regression detected",
      ],
    );

    expect(getTrayAttentionSummary(database)).toEqual({
      skillsObserved: 2,
      pendingReviews: 2,
      attentionRequired: 2,
      hasCritical: true,
      criticalCount: 1,
    });
  });
});
