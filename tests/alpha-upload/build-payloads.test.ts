/**
 * Tests for alpha upload payload builder.
 *
 * Validates that buildSessionPayloads, buildInvocationPayloads, and
 * buildEvolutionPayloads correctly read SQLite rows and map them into
 * AlphaUploadEnvelope payloads.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ALL_DDL, MIGRATIONS, POST_MIGRATION_INDEXES } from "../../cli/selftune/localdb/schema.js";
import {
  buildSessionPayloads,
  buildInvocationPayloads,
  buildEvolutionPayloads,
} from "../../cli/selftune/alpha-upload/build-payloads.js";
import type {
  AlphaUploadEnvelope,
  AlphaSessionPayload,
  AlphaInvocationPayload,
  AlphaEvolutionPayload,
} from "../../cli/selftune/alpha-upload-contract.js";

// -- Test helpers -------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  for (const ddl of ALL_DDL) db.run(ddl);
  for (const m of MIGRATIONS) {
    try { db.run(m); } catch { /* duplicate column OK */ }
  }
  for (const idx of POST_MIGRATION_INDEXES) {
    try { db.run(idx); } catch { /* already exists OK */ }
  }
  return db;
}

function insertSession(db: Database, overrides: Partial<{
  session_id: string;
  started_at: string;
  ended_at: string;
  platform: string;
  model: string;
  completion_status: string;
  workspace_path: string;
}> = {}): void {
  const s = {
    session_id: overrides.session_id ?? `sess-${Math.random().toString(36).slice(2)}`,
    started_at: overrides.started_at ?? "2026-03-18T10:00:00Z",
    ended_at: overrides.ended_at ?? "2026-03-18T10:05:00Z",
    platform: overrides.platform ?? "claude_code",
    model: overrides.model ?? "opus",
    completion_status: overrides.completion_status ?? "completed",
    workspace_path: overrides.workspace_path ?? "/home/user/project",
  };
  db.run(
    `INSERT INTO sessions (session_id, started_at, ended_at, platform, model, completion_status, workspace_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [s.session_id, s.started_at, s.ended_at, s.platform, s.model, s.completion_status, s.workspace_path],
  );
}

function insertSessionTelemetry(db: Database, overrides: Partial<{
  session_id: string;
  timestamp: string;
  total_tool_calls: number;
  assistant_turns: number;
  errors_encountered: number;
  skills_triggered_json: string;
}> = {}): void {
  const t = {
    session_id: overrides.session_id ?? `sess-${Math.random().toString(36).slice(2)}`,
    timestamp: overrides.timestamp ?? "2026-03-18T10:05:00Z",
    total_tool_calls: overrides.total_tool_calls ?? 5,
    assistant_turns: overrides.assistant_turns ?? 3,
    errors_encountered: overrides.errors_encountered ?? 0,
    skills_triggered_json: overrides.skills_triggered_json ?? '["selftune"]',
  };
  db.run(
    `INSERT INTO session_telemetry (session_id, timestamp, total_tool_calls, assistant_turns, errors_encountered, skills_triggered_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [t.session_id, t.timestamp, t.total_tool_calls, t.assistant_turns, t.errors_encountered, t.skills_triggered_json],
  );
}

function insertInvocation(db: Database, overrides: Partial<{
  skill_invocation_id: string;
  session_id: string;
  occurred_at: string;
  skill_name: string;
  invocation_mode: string;
  triggered: number;
  confidence: number;
  query: string;
  skill_scope: string;
  source: string;
}> = {}): void {
  const inv = {
    skill_invocation_id: overrides.skill_invocation_id ?? `inv-${Math.random().toString(36).slice(2)}`,
    session_id: overrides.session_id ?? "sess-1",
    occurred_at: overrides.occurred_at ?? "2026-03-18T10:01:00Z",
    skill_name: overrides.skill_name ?? "selftune",
    invocation_mode: overrides.invocation_mode ?? "implicit",
    triggered: overrides.triggered ?? 1,
    confidence: overrides.confidence ?? 0.95,
    query: overrides.query ?? "improve my skills",
    skill_scope: overrides.skill_scope ?? "global",
    source: overrides.source ?? "hook",
  };
  db.run(
    `INSERT INTO skill_invocations (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode, triggered, confidence, query, skill_scope, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [inv.skill_invocation_id, inv.session_id, inv.occurred_at, inv.skill_name, inv.invocation_mode, inv.triggered, inv.confidence, inv.query, inv.skill_scope, inv.source],
  );
}

function insertEvolutionAudit(db: Database, overrides: Partial<{
  timestamp: string;
  proposal_id: string;
  skill_name: string;
  action: string;
  details: string;
  eval_snapshot_json: string;
}> = {}): void {
  const e = {
    timestamp: overrides.timestamp ?? "2026-03-18T10:10:00Z",
    proposal_id: overrides.proposal_id ?? `prop-${Math.random().toString(36).slice(2)}`,
    skill_name: overrides.skill_name ?? "selftune",
    action: overrides.action ?? "deployed",
    details: overrides.details ?? "improved pass rate from 0.6 to 0.8",
    eval_snapshot_json: overrides.eval_snapshot_json ?? '{"total":10,"passed":8,"failed":2,"pass_rate":0.8}',
  };
  db.run(
    `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details, eval_snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [e.timestamp, e.proposal_id, e.skill_name, e.action, e.details, e.eval_snapshot_json],
  );
}

const TEST_USER_ID = "alpha-user-001";
const TEST_AGENT_TYPE = "claude_code";
const TEST_VERSION = "0.2.7";

// -- Tests --------------------------------------------------------------------

describe("buildSessionPayloads", () => {
  let db: Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  test("returns null when no sessions exist", () => {
    const result = buildSessionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    expect(result).toBeNull();
  });

  test("returns null when no sessions after afterId", () => {
    insertSession(db, { session_id: "sess-1" });
    insertSessionTelemetry(db, { session_id: "sess-1" });
    // Use a high afterId that no row exceeds
    const result = buildSessionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION, 999999);
    expect(result).toBeNull();
  });

  test("builds envelope with correct metadata", () => {
    insertSession(db, { session_id: "sess-1" });
    insertSessionTelemetry(db, { session_id: "sess-1" });

    const result = buildSessionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    expect(result).not.toBeNull();

    const env = result!.envelope;
    expect(env.schema_version).toBe("alpha-1.0");
    expect(env.user_id).toBe(TEST_USER_ID);
    expect(env.agent_type).toBe(TEST_AGENT_TYPE);
    expect(env.selftune_version).toBe(TEST_VERSION);
    expect(env.payload_type).toBe("sessions");
    expect(env.uploaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("maps session fields correctly", () => {
    insertSession(db, {
      session_id: "sess-map",
      platform: "claude_code",
      model: "opus",
      started_at: "2026-03-18T10:00:00Z",
      ended_at: "2026-03-18T10:05:00Z",
      completion_status: "completed",
      workspace_path: "/home/user/project",
    });
    insertSessionTelemetry(db, {
      session_id: "sess-map",
      total_tool_calls: 12,
      assistant_turns: 4,
      errors_encountered: 1,
      skills_triggered_json: '["selftune","dev"]',
    });

    const result = buildSessionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaSessionPayload[];

    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.session_id).toBe("sess-map");
    expect(p.platform).toBe("claude_code");
    expect(p.model).toBe("opus");
    expect(p.started_at).toBe("2026-03-18T10:00:00Z");
    expect(p.ended_at).toBe("2026-03-18T10:05:00Z");
    expect(p.total_tool_calls).toBe(12);
    expect(p.assistant_turns).toBe(4);
    expect(p.errors_encountered).toBe(1);
    expect(p.skills_triggered).toEqual(["selftune", "dev"]);
    expect(p.completion_status).toBe("completed");
    // workspace_hash should be a SHA256 hex string, not the raw path
    expect(p.workspace_hash).not.toBe("/home/user/project");
    expect(p.workspace_hash).toHaveLength(64); // SHA256 hex
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      const sid = `sess-limit-${i}`;
      insertSession(db, { session_id: sid });
      insertSessionTelemetry(db, { session_id: sid });
    }

    const result = buildSessionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION, undefined, 3);
    const payloads = result!.envelope.payload as AlphaSessionPayload[];
    expect(payloads.length).toBeLessThanOrEqual(3);
  });

  test("returns lastId for pagination", () => {
    insertSession(db, { session_id: "sess-page-1" });
    insertSessionTelemetry(db, { session_id: "sess-page-1" });
    insertSession(db, { session_id: "sess-page-2" });
    insertSessionTelemetry(db, { session_id: "sess-page-2" });

    const result = buildSessionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    expect(result!.lastId).toBeGreaterThan(0);
  });
});

describe("buildInvocationPayloads", () => {
  let db: Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  test("returns null when no invocations exist", () => {
    const result = buildInvocationPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    expect(result).toBeNull();
  });

  test("builds envelope with correct payload_type", () => {
    insertInvocation(db);
    const result = buildInvocationPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    expect(result).not.toBeNull();
    expect(result!.envelope.payload_type).toBe("invocations");
  });

  test("maps invocation fields correctly", () => {
    insertInvocation(db, {
      skill_invocation_id: "inv-map",
      session_id: "sess-inv",
      occurred_at: "2026-03-18T10:01:00Z",
      skill_name: "selftune",
      invocation_mode: "implicit",
      triggered: 1,
      confidence: 0.95,
      query: "improve my skills",
      skill_scope: "global",
      source: "hook",
    });

    const result = buildInvocationPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaInvocationPayload[];

    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.session_id).toBe("sess-inv");
    expect(p.occurred_at).toBe("2026-03-18T10:01:00Z");
    expect(p.skill_name).toBe("selftune");
    expect(p.invocation_mode).toBe("implicit");
    expect(p.triggered).toBe(true);
    expect(p.confidence).toBe(0.95);
    expect(p.query_text).toBe("improve my skills"); // raw, no hashing
    expect(p.skill_scope).toBe("global");
    expect(p.source).toBe("hook");
  });

  test("query_text passes through unchanged", () => {
    const rawQuery = "set up selftune for my /Users/dan/secret-project";
    insertInvocation(db, { query: rawQuery });

    const result = buildInvocationPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaInvocationPayload[];
    expect(payloads[0].query_text).toBe(rawQuery);
  });

  test("handles null confidence and source", () => {
    db.run(
      `INSERT INTO skill_invocations (skill_invocation_id, session_id, occurred_at, skill_name, triggered, query)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["inv-null", "sess-null", "2026-03-18T10:01:00Z", "selftune", 0, "test"],
    );

    const result = buildInvocationPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaInvocationPayload[];
    expect(payloads[0].confidence).toBeNull();
    expect(payloads[0].source).toBeNull();
  });

  test("respects afterId for pagination", () => {
    insertInvocation(db, { skill_invocation_id: "inv-1", query: "first" });
    insertInvocation(db, { skill_invocation_id: "inv-2", query: "second" });

    // Get the rowid for the first invocation
    const firstRow = db.query("SELECT rowid FROM skill_invocations WHERE skill_invocation_id = 'inv-1'").get() as { rowid: number };

    const result = buildInvocationPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION, firstRow.rowid);
    const payloads = result!.envelope.payload as AlphaInvocationPayload[];
    // Should only return inv-2
    expect(payloads).toHaveLength(1);
    expect(payloads[0].query_text).toBe("second");
  });
});

describe("buildEvolutionPayloads", () => {
  let db: Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  test("returns null when no evolution audit entries exist", () => {
    const result = buildEvolutionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    expect(result).toBeNull();
  });

  test("builds envelope with correct payload_type", () => {
    insertEvolutionAudit(db);
    const result = buildEvolutionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    expect(result).not.toBeNull();
    expect(result!.envelope.payload_type).toBe("evolution");
  });

  test("maps evolution fields correctly", () => {
    insertEvolutionAudit(db, {
      proposal_id: "prop-map",
      skill_name: "selftune",
      action: "deployed",
      timestamp: "2026-03-18T10:10:00Z",
      eval_snapshot_json: '{"total":10,"passed":8,"failed":2,"pass_rate":0.8}',
    });

    const result = buildEvolutionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaEvolutionPayload[];

    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.proposal_id).toBe("prop-map");
    expect(p.skill_name).toBe("selftune");
    expect(p.action).toBe("deployed");
    expect(p.timestamp).toBe("2026-03-18T10:10:00Z");
    expect(p.deployed).toBe(true);
    expect(p.rolled_back).toBe(false);
    expect(p.after_pass_rate).toBe(0.8);
  });

  test("maps rolled_back action correctly", () => {
    insertEvolutionAudit(db, {
      action: "rolled_back",
      eval_snapshot_json: '{"total":10,"passed":5,"failed":5,"pass_rate":0.5}',
    });

    const result = buildEvolutionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaEvolutionPayload[];
    expect(payloads[0].deployed).toBe(false);
    expect(payloads[0].rolled_back).toBe(true);
  });

  test("handles null eval_snapshot_json", () => {
    db.run(
      `INSERT INTO evolution_audit (timestamp, proposal_id, skill_name, action, details)
       VALUES (?, ?, ?, ?, ?)`,
      ["2026-03-18T10:10:00Z", "prop-null", "selftune", "created", "initial proposal"],
    );

    const result = buildEvolutionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaEvolutionPayload[];
    expect(payloads[0].before_pass_rate).toBeNull();
    expect(payloads[0].after_pass_rate).toBeNull();
    expect(payloads[0].net_change).toBeNull();
  });

  test("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertEvolutionAudit(db, { proposal_id: `prop-${i}` });
    }

    const result = buildEvolutionPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION, undefined, 2);
    const payloads = result!.envelope.payload as AlphaEvolutionPayload[];
    expect(payloads).toHaveLength(2);
  });
});

describe("batch size cap", () => {
  let db: Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  test("default limit caps at 100 records", () => {
    for (let i = 0; i < 120; i++) {
      insertInvocation(db, {
        skill_invocation_id: `inv-cap-${i}`,
        query: `query ${i}`,
      });
    }

    const result = buildInvocationPayloads(db, TEST_USER_ID, TEST_AGENT_TYPE, TEST_VERSION);
    const payloads = result!.envelope.payload as AlphaInvocationPayload[];
    expect(payloads).toHaveLength(100);
  });
});
