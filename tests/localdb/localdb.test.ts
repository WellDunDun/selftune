import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

/**
 * Tests for the selftune local SQLite materialized view store.
 * Covers schema creation, materialization, and query helpers.
 *
 * All tests use :memory: databases — no filesystem side effects.
 */

import { getMeta, openDb, setMeta } from "../../cli/selftune/localdb/db.js";
import {
  getOverviewPayload,
  getSkillReportPayload,
  getSkillsList,
} from "../../cli/selftune/localdb/queries.js";
import { ALL_DDL } from "../../cli/selftune/localdb/schema.js";

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("localdb schema", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all expected tables", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("sessions");
    expect(names).toContain("prompts");
    expect(names).toContain("skill_invocations");
    expect(names).toContain("execution_facts");
    expect(names).toContain("evolution_evidence");
    expect(names).toContain("evolution_audit");
    expect(names).toContain("session_telemetry");
    expect(names).toContain("skill_usage");
    expect(names).toContain("orchestrate_runs");
    expect(names).toContain("queries");
    expect(names).toContain("improvement_signals");
    expect(names).toContain("_meta");
  });

  it("creates queries table with expected columns", () => {
    const cols = db.query("PRAGMA table_info(queries)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["timestamp", "session_id", "query"]));
  });

  it("creates improvement_signals table with expected columns", () => {
    const cols = db.query("PRAGMA table_info(improvement_signals)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["timestamp", "session_id", "signal_type"]));
  });

  it("creates indexes on session_id and timestamp columns", () => {
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);

    expect(names).toContain("idx_prompts_session");
    expect(names).toContain("idx_prompts_occurred");
    expect(names).toContain("idx_skill_inv_session");
    expect(names).toContain("idx_skill_inv_name");
    expect(names).toContain("idx_exec_facts_session");
    expect(names).toContain("idx_evo_evidence_proposal");
    expect(names).toContain("idx_evo_evidence_skill");
    expect(names).toContain("idx_evo_evidence_ts");
    expect(names).toContain("idx_evo_audit_proposal");
    expect(names).toContain("idx_evo_audit_ts");
    expect(names).toContain("idx_session_tel_ts");
    expect(names).toContain("idx_skill_usage_session");
    expect(names).toContain("idx_skill_usage_name");
    expect(names).toContain("idx_skill_usage_ts");
    expect(names).toContain("idx_skill_usage_query_triggered");
    expect(names).toContain("idx_evo_audit_action");
    // Orchestrate, query log, and signal indexes
    expect(names).toContain("idx_orchestrate_runs_ts");
    expect(names).toContain("idx_queries_session");
    expect(names).toContain("idx_queries_ts");
    expect(names).toContain("idx_signals_session");
    expect(names).toContain("idx_signals_consumed");
    expect(names).toContain("idx_signals_ts");
  });

  it("creates UNIQUE dedup indexes for materializer idempotency", () => {
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%dedup'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);

    expect(names).toContain("idx_skill_usage_dedup");
    expect(names).toContain("idx_evo_audit_dedup");
    expect(names).toContain("idx_evo_evidence_dedup");
    expect(names).toContain("idx_queries_dedup");
    expect(names).toContain("idx_signals_dedup");
  });

  it("is idempotent — re-running DDL does not fail", () => {
    // Run all DDL again
    for (const ddl of ALL_DDL) {
      db.run(ddl);
    }
    // If we get here without error, it's idempotent
    const tables = db.query("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get() as {
      c: number;
    };
    expect(tables.c).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Meta helpers tests
// ---------------------------------------------------------------------------

describe("localdb meta helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("getMeta returns null for missing key", () => {
    expect(getMeta(db, "nonexistent")).toBeNull();
  });

  it("setMeta + getMeta round-trips", () => {
    setMeta(db, "test_key", "test_value");
    expect(getMeta(db, "test_key")).toBe("test_value");
  });

  it("setMeta overwrites existing value", () => {
    setMeta(db, "key", "v1");
    setMeta(db, "key", "v2");
    expect(getMeta(db, "key")).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// Materialization tests (direct insert, no file I/O)
// ---------------------------------------------------------------------------

describe("localdb materialization", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts session telemetry records", () => {
    db.run(
      `INSERT INTO session_telemetry
        (session_id, timestamp, total_tool_calls, errors_encountered, skills_triggered_json, assistant_turns, transcript_chars, last_user_query)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-1", "2026-03-12T10:00:00Z", 5, 0, '["Research"]', 3, 1000, "hello"],
    );

    const count = (db.query("SELECT COUNT(*) as c FROM session_telemetry").get() as { c: number })
      .c;
    expect(count).toBe(1);
  });

  it("inserts skill invocation records with usage columns", () => {
    // Session stub for FK
    db.run(
      `INSERT OR IGNORE INTO sessions (session_id, platform, schema_version, normalized_at)
       VALUES (?, ?, ?, ?)`,
      ["sess-1", "claude_code", "2.0", "2026-03-12T10:00:00Z"],
    );
    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, query, triggered, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "si-mat-1",
        "sess-1",
        "2026-03-12T10:00:00Z",
        "Research",
        "/skills/Research/SKILL.md",
        "do research",
        1,
        "hook",
      ],
    );
    db.run(
      `INSERT INTO skill_invocations
        (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, query, triggered, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "si-mat-2",
        "sess-1",
        "2026-03-12T10:01:00Z",
        "Browser",
        "/skills/Browser/SKILL.md",
        "check page",
        0,
        "hook",
      ],
    );

    const count = (db.query("SELECT COUNT(*) as c FROM skill_invocations").get() as { c: number })
      .c;
    expect(count).toBe(2);
  });

  it("inserts canonical session records with INSERT OR IGNORE", () => {
    db.run(
      `INSERT INTO sessions (session_id, platform, schema_version, normalized_at)
       VALUES (?, ?, ?, ?)`,
      ["sess-1", "claude_code", "2.0", "2026-03-12T10:00:00Z"],
    );
    // Duplicate should be ignored
    db.run(
      `INSERT OR IGNORE INTO sessions (session_id, platform, schema_version, normalized_at)
       VALUES (?, ?, ?, ?)`,
      ["sess-1", "claude_code", "2.0", "2026-03-12T10:00:00Z"],
    );

    const count = (db.query("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("inserts evolution audit records", () => {
    db.run(
      `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-03-12T10:00:00Z", "prop-1", "Research", "created", "Initial proposal"],
    );
    db.run(
      `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-03-12T10:05:00Z", "prop-1", "Research", "validated", "Passed gates"],
    );

    const count = (db.query("SELECT COUNT(*) as c FROM evolution_audit").get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it("inserts evolution evidence with JSON validation field", () => {
    const validation = JSON.stringify({
      improved: true,
      before_pass_rate: 0.6,
      after_pass_rate: 0.8,
      net_change: 0.2,
    });

    db.run(
      `INSERT INTO evolution_evidence
        (timestamp, proposal_id, skill_name, skill_path, target, stage, confidence, validation_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-03-12T10:00:00Z",
        "prop-1",
        "Research",
        "/path",
        "description",
        "validated",
        0.85,
        validation,
      ],
    );

    const row = db
      .query("SELECT validation_json FROM evolution_evidence WHERE proposal_id = ?")
      .get("prop-1") as { validation_json: string };
    const parsed = JSON.parse(row.validation_json);
    expect(parsed.improved).toBe(true);
    expect(parsed.net_change).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// Query helper tests
// ---------------------------------------------------------------------------

describe("localdb queries", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
    seedTestData(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("getOverviewPayload", () => {
    it("returns telemetry with parsed skills_triggered", () => {
      const payload = getOverviewPayload(db);
      expect(payload.telemetry).toHaveLength(2);
      expect(payload.telemetry[0].skills_triggered).toEqual(["Browser"]);
      expect(payload.telemetry[1].skills_triggered).toEqual(["Research"]);
    });

    it("returns skill usage with boolean triggered", () => {
      const payload = getOverviewPayload(db);
      expect(payload.skills).toHaveLength(3);
      const triggered = payload.skills.filter((s) => s.triggered);
      expect(triggered.length).toBeGreaterThan(0);
    });

    it("returns correct counts", () => {
      const payload = getOverviewPayload(db);
      expect(payload.counts.telemetry).toBe(2);
      expect(payload.counts.skills).toBe(3);
      expect(payload.counts.evolution).toBe(2);
    });

    it("returns evolution audit entries", () => {
      const payload = getOverviewPayload(db);
      expect(payload.evolution).toHaveLength(2);
      expect(payload.evolution[0].proposal_id).toBe("prop-1");
    });

    it("detects unmatched queries", () => {
      const payload = getOverviewPayload(db);
      // "unmatched query" is not triggered and no other triggered record has the same query
      const unmatched = payload.unmatched_queries;
      expect(unmatched.length).toBeGreaterThanOrEqual(1);
      expect(unmatched.some((u) => u.query === "unmatched query")).toBe(true);
    });

    it("detects pending proposals", () => {
      const payload = getOverviewPayload(db);
      expect(payload.pending_proposals).toHaveLength(1);
      expect(payload.pending_proposals[0].proposal_id).toBe("prop-1");
    });
  });

  describe("getSkillReportPayload", () => {
    it("returns usage stats for a known skill", () => {
      const report = getSkillReportPayload(db, "Research");
      expect(report.skill_name).toBe("Research");
      expect(report.usage.total_checks).toBe(2);
      expect(report.usage.triggered_count).toBe(1);
      expect(report.usage.pass_rate).toBe(0.5);
    });

    it("returns recent invocations", () => {
      const report = getSkillReportPayload(db, "Research");
      expect(report.recent_invocations).toHaveLength(2);
      expect(report.recent_invocations[0].triggered).toBeDefined();
    });

    it("returns evolution evidence", () => {
      const report = getSkillReportPayload(db, "Research");
      expect(report.evidence).toHaveLength(1);
      expect(report.evidence[0].proposal_id).toBe("prop-1");
    });

    it("returns zero stats for unknown skill", () => {
      const report = getSkillReportPayload(db, "Nonexistent");
      expect(report.usage.total_checks).toBe(0);
      expect(report.usage.pass_rate).toBe(0);
      expect(report.recent_invocations).toHaveLength(0);
    });

    it("counts unique sessions", () => {
      const report = getSkillReportPayload(db, "Research");
      expect(report.sessions_with_skill).toBe(2);
    });
  });

  describe("getSkillsList", () => {
    it("returns all skills with aggregated stats", () => {
      const list = getSkillsList(db);
      expect(list.length).toBeGreaterThanOrEqual(2);

      const research = list.find((s) => s.skill_name === "Research");
      expect(research).toBeDefined();
      expect(research?.total_checks).toBe(2);
      expect(research?.has_evidence).toBe(true);
    });

    it("marks skills without evidence", () => {
      const list = getSkillsList(db);
      const browser = list.find((s) => s.skill_name === "Browser");
      expect(browser).toBeDefined();
      expect(browser?.has_evidence).toBe(false);
    });

    it("includes last_seen timestamp", () => {
      const list = getSkillsList(db);
      for (const skill of list) {
        expect(skill.last_seen).not.toBeNull();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test data seeder
// ---------------------------------------------------------------------------

function seedTestData(db: Database): void {
  // Session telemetry
  db.run(
    `INSERT INTO session_telemetry
      (session_id, timestamp, total_tool_calls, errors_encountered, skills_triggered_json, assistant_turns, transcript_chars, last_user_query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["sess-1", "2026-03-12T10:00:00Z", 5, 0, '["Research"]', 3, 1000, "do research"],
  );
  db.run(
    `INSERT INTO session_telemetry
      (session_id, timestamp, total_tool_calls, errors_encountered, skills_triggered_json, assistant_turns, transcript_chars, last_user_query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["sess-2", "2026-03-12T11:00:00Z", 8, 1, '["Browser"]', 5, 2000, "check page"],
  );

  // Session stubs for FK satisfaction
  db.run(
    `INSERT OR IGNORE INTO sessions (session_id, platform, schema_version, normalized_at)
     VALUES (?, ?, ?, ?)`,
    ["sess-1", "claude_code", "2.0", "2026-03-12T10:00:00Z"],
  );
  db.run(
    `INSERT OR IGNORE INTO sessions (session_id, platform, schema_version, normalized_at)
     VALUES (?, ?, ?, ?)`,
    ["sess-2", "claude_code", "2.0", "2026-03-12T11:00:00Z"],
  );

  // Skill invocations (unified table, replaces skill_usage)
  db.run(
    `INSERT INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, query, triggered, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "si-seed-1",
      "sess-1",
      "2026-03-12T10:00:00Z",
      "Research",
      "/skills/Research/SKILL.md",
      "do research",
      1,
      "hook",
    ],
  );
  db.run(
    `INSERT INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, query, triggered, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "si-seed-2",
      "sess-2",
      "2026-03-12T11:00:00Z",
      "Research",
      "/skills/Research/SKILL.md",
      "unmatched query",
      0,
      "hook",
    ],
  );
  db.run(
    `INSERT INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, skill_path, query, triggered, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "si-seed-3",
      "sess-2",
      "2026-03-12T11:00:00Z",
      "Browser",
      "/skills/Browser/SKILL.md",
      "check page",
      1,
      "hook",
    ],
  );

  // Evolution audit
  db.run(
    `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details)
     VALUES (?, ?, ?, ?, ?)`,
    ["2026-03-12T10:00:00Z", "prop-1", "Research", "created", "Initial proposal"],
  );
  db.run(
    `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details)
     VALUES (?, ?, ?, ?, ?)`,
    ["2026-03-12T10:05:00Z", "prop-1", "Research", "validated", "Passed gates"],
  );

  // Evolution evidence
  db.run(
    `INSERT INTO evolution_evidence
      (timestamp, proposal_id, skill_name, skill_path, target, stage, confidence, validation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "2026-03-12T10:00:00Z",
      "prop-1",
      "Research",
      "/skills/Research/SKILL.md",
      "description",
      "validated",
      0.85,
      JSON.stringify({ improved: true, before_pass_rate: 0.6, after_pass_rate: 0.8 }),
    ],
  );
}
