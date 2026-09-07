import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../packages/runtime/localdb/db.js";
import {
  getRecentDecisions,
  queryTrustedSkillObservationRows,
} from "../../packages/runtime/localdb/queries/trust.js";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => {
  db.close();
});

describe("trust query JSON projections", () => {
  test("classifies valid regression arrays without accepting malformed evidence as failures", () => {
    const insert = db.prepare(
      "INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, eval_snapshot_json) VALUES (?, ?, 'marketing', 'validated', ?)",
    );
    const timestamp = new Date().toISOString();
    for (const [proposal, snapshot] of [
      ["regressed", JSON.stringify({ regressions: [{ query: "write copy" }] })],
      ["historical", JSON.stringify({ regressions: ["write copy"] })],
      ["empty", JSON.stringify({ regressions: [] })],
      ["malformed", "{broken"],
      ["scalar", JSON.stringify({ regressions: "broken" })],
      ["null", "null"],
    ])
      insert.run(timestamp, proposal, snapshot);
    const decisions = new Map(getRecentDecisions(db).map((row) => [row.proposal_id, row.kind]));
    expect(decisions.get("regressed")).toBe("validation_failed");
    expect(decisions.get("historical")).toBe("validation_failed");
    for (const id of ["empty", "malformed", "scalar", "null"])
      expect(decisions.get(id)).toBe("proposal_created");
  });

  test("omits audit rows without a skill before applying the requested limit", () => {
    db.run(
      "INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action) VALUES (?, 'valid', 'marketing', 'deployed')",
      [new Date(Date.now() - 1000).toISOString()],
    );
    db.run(
      "INSERT INTO evolution_audit (timestamp, proposal_id, action) VALUES (?, 'unscoped', 'deployed')",
      [new Date().toISOString()],
    );
    expect(getRecentDecisions(db, 1).map((row) => row.proposal_id)).toEqual(["valid"]);
  });

  test("prefers repaired triggers over contextual misses and survives unreadable source metadata", () => {
    db.run("INSERT INTO sessions (session_id) VALUES ('session')");
    const insert = db.prepare(
      "INSERT INTO skill_invocations (skill_invocation_id, session_id, skill_name, occurred_at, triggered, capture_mode, raw_source_ref, query) VALUES (?, 'session', 'marketing', ?, 0, 'repair', ?, 'write copy')",
    );
    insert.run(
      "context",
      "2026-09-05",
      JSON.stringify({ metadata: { miss_type: "contextual_read" } }),
    );
    insert.run("trigger", "2026-09-04", JSON.stringify({ metadata: { miss_type: "explicit" } }));
    expect(queryTrustedSkillObservationRows(db).map((row) => row.occurred_at)).toEqual([
      "2026-09-04",
    ]);
    db.run("DELETE FROM skill_invocations WHERE skill_invocation_id = 'trigger'");
    insert.run("unreadable", "2026-09-03", "{broken");
    expect(queryTrustedSkillObservationRows(db).map((row) => row.occurred_at)).toEqual([
      "2026-09-03",
    ]);
  });
});
