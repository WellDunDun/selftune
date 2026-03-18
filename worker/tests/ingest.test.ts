import { describe, expect, it, beforeEach } from "bun:test";
import { ingestEnvelope } from "../src/ingest";
import type {
  AlphaUploadEnvelope,
  AlphaSessionPayload,
  AlphaInvocationPayload,
  AlphaEvolutionPayload,
} from "../src/types";

/**
 * Mock D1Database for testing.
 *
 * Captures prepared statements and batch calls so we can assert
 * the correct SQL was generated without a real D1 binding.
 */
class MockD1Statement {
  sql: string;
  boundValues: unknown[] = [];

  constructor(sql: string) {
    this.sql = sql;
  }

  bind(...values: unknown[]) {
    this.boundValues = values;
    return this;
  }

  async run() {
    return { success: true, meta: { changes: 1 } };
  }
}

class MockD1Database {
  preparedStatements: MockD1Statement[] = [];
  batchedStatements: MockD1Statement[] = [];

  prepare(sql: string) {
    const stmt = new MockD1Statement(sql);
    this.preparedStatements.push(stmt);
    return stmt;
  }

  async batch(stmts: MockD1Statement[]) {
    this.batchedStatements.push(...stmts);
    return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

function makeSessionEnvelope(
  payloads: AlphaSessionPayload[]
): AlphaUploadEnvelope {
  return {
    schema_version: "alpha-1.0",
    user_id: "user-test-001",
    agent_type: "claude-code",
    selftune_version: "0.2.2",
    uploaded_at: "2026-03-18T12:00:00Z",
    payload_type: "sessions",
    payload: payloads,
  };
}

function makeInvocationEnvelope(
  payloads: AlphaInvocationPayload[]
): AlphaUploadEnvelope {
  return {
    schema_version: "alpha-1.0",
    user_id: "user-test-001",
    agent_type: "claude-code",
    selftune_version: "0.2.2",
    uploaded_at: "2026-03-18T12:00:00Z",
    payload_type: "invocations",
    payload: payloads,
  };
}

function makeEvolutionEnvelope(
  payloads: AlphaEvolutionPayload[]
): AlphaUploadEnvelope {
  return {
    schema_version: "alpha-1.0",
    user_id: "user-test-001",
    agent_type: "claude-code",
    selftune_version: "0.2.2",
    uploaded_at: "2026-03-18T12:00:00Z",
    payload_type: "evolution",
    payload: payloads,
  };
}

describe("ingestEnvelope", () => {
  let db: MockD1Database;

  beforeEach(() => {
    db = new MockD1Database();
  });

  it("ingests session payloads and returns accepted count", async () => {
    const envelope = makeSessionEnvelope([
      {
        session_id: "sess-001",
        platform: "darwin",
        model: "claude-4",
        workspace_hash: "hash123",
        started_at: "2026-03-18T11:00:00Z",
        ended_at: "2026-03-18T11:30:00Z",
        total_tool_calls: 10,
        assistant_turns: 4,
        errors_encountered: 1,
        skills_triggered: ["selftune", "git"],
        completion_status: "completed",
      },
    ]);

    const result = await ingestEnvelope(db as any, envelope);

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Should have prepared: user upsert + session insert
    const sqls = db.batchedStatements.map((s) => s.sql);
    expect(sqls.some((s) => s.includes("alpha_users"))).toBe(true);
    expect(sqls.some((s) => s.includes("alpha_sessions"))).toBe(true);
  });

  it("ingests invocation payloads", async () => {
    const envelope = makeInvocationEnvelope([
      {
        session_id: "sess-001",
        occurred_at: "2026-03-18T11:05:00Z",
        skill_name: "selftune",
        invocation_mode: "auto",
        triggered: true,
        confidence: 0.9,
        query_text: "set up selftune",
        skill_scope: null,
        source: "hook",
      },
      {
        session_id: "sess-001",
        occurred_at: "2026-03-18T11:06:00Z",
        skill_name: "git",
        invocation_mode: "manual",
        triggered: false,
        confidence: 0.3,
        query_text: "commit changes",
        skill_scope: null,
        source: "hook",
      },
    ]);

    const result = await ingestEnvelope(db as any, envelope);

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(0);

    const sqls = db.batchedStatements.map((s) => s.sql);
    expect(sqls.some((s) => s.includes("alpha_invocations"))).toBe(true);
  });

  it("ingests evolution payloads", async () => {
    const envelope = makeEvolutionEnvelope([
      {
        proposal_id: "prop-001",
        skill_name: "selftune",
        action: "update-description",
        before_pass_rate: 0.5,
        after_pass_rate: 0.8,
        net_change: 0.3,
        deployed: true,
        rolled_back: false,
        timestamp: "2026-03-18T11:30:00Z",
      },
    ]);

    const result = await ingestEnvelope(db as any, envelope);

    expect(result.success).toBe(true);
    expect(result.accepted).toBe(1);

    const sqls = db.batchedStatements.map((s) => s.sql);
    expect(sqls.some((s) => s.includes("alpha_evolution_outcomes"))).toBe(true);
  });

  it("converts boolean fields to integers for D1", async () => {
    const envelope = makeInvocationEnvelope([
      {
        session_id: "sess-001",
        occurred_at: "2026-03-18T11:05:00Z",
        skill_name: "selftune",
        invocation_mode: null,
        triggered: true,
        confidence: null,
        query_text: "test",
        skill_scope: null,
        source: null,
      },
    ]);

    await ingestEnvelope(db as any, envelope);

    // The invocation insert statement should have bound 1 (not true) for triggered
    const invStmt = db.batchedStatements.find((s) =>
      s.sql.includes("alpha_invocations")
    );
    expect(invStmt).toBeDefined();
    // triggered is the 6th bound value (user_id, session_id, occurred_at, skill_name, invocation_mode, triggered, ...)
    expect(invStmt!.boundValues[5]).toBe(1);
  });

  it("serializes skills_triggered array to JSON string", async () => {
    const envelope = makeSessionEnvelope([
      {
        session_id: "sess-002",
        platform: null,
        model: null,
        workspace_hash: "hash456",
        started_at: null,
        ended_at: null,
        total_tool_calls: 0,
        assistant_turns: 0,
        errors_encountered: 0,
        skills_triggered: ["a", "b", "c"],
        completion_status: null,
      },
    ]);

    await ingestEnvelope(db as any, envelope);

    const sessionStmt = db.batchedStatements.find((s) =>
      s.sql.includes("alpha_sessions")
    );
    expect(sessionStmt).toBeDefined();
    // skills_triggered_json should be a JSON string
    const jsonVal = sessionStmt!.boundValues.find(
      (v) => typeof v === "string" && v.startsWith("[")
    );
    expect(jsonVal).toBe('["a","b","c"]');
  });

  it("handles database errors gracefully", async () => {
    const failDb = {
      prepare(sql: string) {
        return {
          sql,
          bind(..._values: unknown[]) {
            return this;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
      async batch() {
        throw new Error("D1 connection failed");
      },
    };

    const envelope = makeSessionEnvelope([
      {
        session_id: "sess-fail",
        platform: null,
        model: null,
        workspace_hash: "hash",
        started_at: null,
        ended_at: null,
        total_tool_calls: 0,
        assistant_turns: 0,
        errors_encountered: 0,
        skills_triggered: [],
        completion_status: null,
      },
    ]);

    const result = await ingestEnvelope(failDb as any, envelope);

    expect(result.success).toBe(false);
    expect(result.accepted).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("D1 connection failed");
  });
});
