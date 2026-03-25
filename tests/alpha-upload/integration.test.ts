/**
 * Integration tests for the alpha upload orchestration module (V2).
 *
 * Tests prepareUploads, runUploadCycle, API key flow, and fail-open contract.
 * Uses an in-memory SQLite database with the full schema applied.
 *
 * The upload pipeline now uses a staging-based approach:
 *   1. stageCanonicalRecords() stages from JSONL + evolution evidence
 *   2. buildV2PushPayload() reads staged records via single monotonic cursor
 *   3. prepareUploads() enqueues the resulting payload
 *
 * Since integration tests seed data directly into SQLite tables (not JSONL),
 * we must also stage them into canonical_upload_staging before prepareUploads
 * can build a payload from them.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { enqueueUpload, getQueueStats } from "../../cli/selftune/alpha-upload/queue.js";
import { ALL_DDL, MIGRATIONS, POST_MIGRATION_INDEXES } from "../../cli/selftune/localdb/schema.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  for (const ddl of ALL_DDL) {
    db.exec(ddl);
  }
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column")) {
        throw error;
      }
    }
  }
  for (const idx of POST_MIGRATION_INDEXES) {
    db.exec(idx);
  }
  return db;
}

/** Stage a canonical session record directly into the staging table. */
function stageSessions(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    const sid = `session-${i}`;
    const record = {
      record_kind: "session",
      schema_version: "2.0",
      normalizer_version: "1.0.0",
      normalized_at: "2026-01-01T00:00:00.000Z",
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: {},
      session_id: sid,
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T01:00:00.000Z",
      model: "opus",
      completion_status: "completed",
    };
    db.run(
      `INSERT OR IGNORE INTO canonical_upload_staging
        (record_kind, record_id, record_json, session_id, staged_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["session", sid, JSON.stringify(record), sid, new Date().toISOString()],
    );
  }
}

/** Stage canonical prompt records directly. */
function stagePrompts(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    const pid = `prompt-${i}`;
    const record = {
      record_kind: "prompt",
      schema_version: "2.0",
      normalizer_version: "1.0.0",
      normalized_at: "2026-01-01T00:00:00.000Z",
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: {},
      session_id: "session-0",
      prompt_id: pid,
      occurred_at: "2026-01-01T00:00:00.000Z",
      prompt_text: "test prompt",
      prompt_kind: "user",
      is_actionable: true,
      prompt_index: i,
    };
    db.run(
      `INSERT OR IGNORE INTO canonical_upload_staging
        (record_kind, record_id, record_json, session_id, prompt_id, staged_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["prompt", pid, JSON.stringify(record), "session-0", pid, new Date().toISOString()],
    );
  }
}

/** Stage canonical invocation records directly. */
function stageInvocations(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    const invId = `inv-${i}`;
    const record = {
      record_kind: "skill_invocation",
      schema_version: "2.0",
      normalizer_version: "1.0.0",
      normalized_at: "2026-01-01T00:00:00.000Z",
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: {},
      session_id: "session-0",
      skill_invocation_id: invId,
      occurred_at: "2026-01-01T00:00:00.000Z",
      skill_name: "Research",
      invocation_mode: "implicit",
      triggered: true,
      confidence: 0.9,
    };
    db.run(
      `INSERT OR IGNORE INTO canonical_upload_staging
        (record_kind, record_id, record_json, session_id, staged_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["skill_invocation", invId, JSON.stringify(record), "session-0", new Date().toISOString()],
    );
  }
}

/** Stage canonical execution fact records directly. */
function stageExecutionFacts(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    const efId = `ef-${i}`;
    const record = {
      record_kind: "execution_fact",
      schema_version: "2.0",
      normalizer_version: "1.0.0",
      normalized_at: "2026-01-01T00:00:00.000Z",
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: {},
      session_id: "session-0",
      execution_fact_id: efId,
      occurred_at: "2026-01-01T00:00:00.000Z",
      tool_calls_json: { Read: 3 },
      total_tool_calls: 3,
      assistant_turns: 2,
      errors_encountered: 0,
    };
    db.run(
      `INSERT OR IGNORE INTO canonical_upload_staging
        (record_kind, record_id, record_json, session_id, staged_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["execution_fact", efId, JSON.stringify(record), "session-0", new Date().toISOString()],
    );
  }
}

/** Stage evolution evidence records directly. */
function stageEvolutionEvidence(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    const recordId = `ev-stage-${i}`;
    const record = {
      evidence_id: recordId,
      timestamp: "2026-01-01T00:00:00.000Z",
      skill_name: "Research",
      skill_path: "/tmp/skills/Research/SKILL.md",
      proposal_id: `prop-${i}`,
      target: "description",
      stage: "deployed",
      rationale: "improved accuracy",
      confidence: 0.85,
      details: "pass rate improved",
      original_text: "old",
      proposed_text: "new",
    };
    db.run(
      `INSERT OR IGNORE INTO canonical_upload_staging
        (record_kind, record_id, record_json, staged_at)
       VALUES (?, ?, ?, ?)`,
      ["evolution_evidence", recordId, JSON.stringify(record), new Date().toISOString()],
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("alpha-upload/index -- prepareUploads (V2 staging)", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty summary when no staged rows exist", async () => {
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");
    const result = prepareUploads(
      db,
      "test-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(result.enqueued).toBe(0);
    expect(result.types).toEqual([]);
  });

  it("enqueues a single V2 push payload from staged sessions", async () => {
    stageSessions(db, 3);
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");
    const result = prepareUploads(
      db,
      "test-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(result.enqueued).toBe(1);
    expect(result.types).toContain("canonical");

    const stats = getQueueStats(db);
    expect(stats.pending).toBe(1);
  });

  it("enqueues payload including staged invocations", async () => {
    stageSessions(db, 1);
    stageInvocations(db, 5);
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");
    const result = prepareUploads(
      db,
      "test-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(result.enqueued).toBe(1);
    expect(result.types).toContain("canonical");
  });

  it("enqueues payload including staged evolution_evidence", async () => {
    stageEvolutionEvidence(db, 2);
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");
    const result = prepareUploads(
      db,
      "test-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(result.enqueued).toBe(1);
    expect(result.types).toContain("canonical");
  });

  it("enqueues payload including all record types", async () => {
    stageSessions(db, 1);
    stagePrompts(db, 2);
    stageInvocations(db, 3);
    stageExecutionFacts(db, 1);
    stageEvolutionEvidence(db, 1);
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");
    const result = prepareUploads(
      db,
      "test-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(result.enqueued).toBe(1);
    expect(result.types).toContain("canonical");
  });

  it("respects watermarks -- does not re-enqueue already-uploaded rows", async () => {
    stageSessions(db, 3);
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");

    // First call enqueues
    const first = prepareUploads(
      db,
      "test-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(first.enqueued).toBe(1);

    // Second call finds no new rows (watermark advanced)
    const second = prepareUploads(
      db,
      "test-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(second.enqueued).toBe(0);
  });

  it("produces V2 payload with schema_version 2.0", async () => {
    stageSessions(db, 1);
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");
    prepareUploads(db, "test-user", "claude_code", "0.2.7", "/nonexistent/canonical.jsonl");

    // Read the queued payload
    const row = db
      .query("SELECT payload_json FROM upload_queue WHERE status = 'pending' LIMIT 1")
      .get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json);
    expect(payload.schema_version).toBe("2.0");
    expect(payload.push_id).toBeDefined();
    expect(payload.canonical).toBeDefined();
    expect(payload.canonical.sessions).toBeDefined();
  });
});

describe("alpha-upload/index -- runUploadCycle (V2 staging)", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty summary when unenrolled", async () => {
    const { runUploadCycle } = await import("../../cli/selftune/alpha-upload/index.js");
    const result = await runUploadCycle(db, {
      enrolled: false,
      endpoint: "https://api.selftune.dev/api/v1/push",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });
    expect(result.enrolled).toBe(false);
    expect(result.prepared).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("prepares and flushes when enrolled (dry-run)", async () => {
    stageSessions(db, 2);

    const { runUploadCycle } = await import("../../cli/selftune/alpha-upload/index.js");
    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "test-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://api.selftune.dev/api/v1/push",
      dryRun: true,
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(result.enrolled).toBe(true);
    expect(result.prepared).toBe(1);
    // In dry-run mode, nothing is actually sent
    expect(result.sent).toBe(0);
  });

  it("passes apiKey through to flush", async () => {
    stageSessions(db, 1);
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | null = null;

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ success: true, push_id: "id", errors: [] }), {
        status: 200,
      });
    });

    try {
      const { runUploadCycle } = await import("../../cli/selftune/alpha-upload/index.js");
      await runUploadCycle(db, {
        enrolled: true,
        userId: "test-user",
        agentType: "claude_code",
        selftuneVersion: "0.2.7",
        endpoint: "https://api.selftune.dev/api/v1/push",
        apiKey: "test-secret-key",
        canonicalLogPath: "/nonexistent/canonical.jsonl",
      });

      expect(capturedHeaders).not.toBeNull();
      if (capturedHeaders === null) {
        throw new Error("fetch was not called - capturedHeaders is null");
      }
      expect(capturedHeaders.get("Authorization")).toBe("Bearer test-secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not throw on upload errors", async () => {
    const { runUploadCycle } = await import("../../cli/selftune/alpha-upload/index.js");

    // Pre-enqueue an item with corrupt JSON to force the fail-open parse path.
    enqueueUpload(db, "push", "not-valid-json");

    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "test-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://api.selftune.dev/api/v1/push",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    // Should not throw -- fail open
    expect(result.enrolled).toBe(true);
    expect(typeof result.prepared).toBe("number");
    expect(typeof result.sent).toBe("number");
    expect(typeof result.failed).toBe("number");
  });
});

describe("alpha-upload/index -- fail-open guarantees (V2 staging)", () => {
  it("prepareUploads never throws even with a broken database", async () => {
    const { prepareUploads } = await import("../../cli/selftune/alpha-upload/index.js");
    const db = new Database(":memory:");
    try {
      // No schema applied -- all queries will fail
      const result = prepareUploads(
        db,
        "test-user",
        "claude_code",
        "0.2.7",
        "/nonexistent/canonical.jsonl",
      );
      expect(result.enqueued).toBe(0);
      expect(result.types).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("runUploadCycle never throws even with a broken database", async () => {
    const { runUploadCycle } = await import("../../cli/selftune/alpha-upload/index.js");
    const db = new Database(":memory:");
    try {
      // No schema applied
      const result = await runUploadCycle(db, {
        enrolled: true,
        userId: "test-user",
        agentType: "claude_code",
        selftuneVersion: "0.2.7",
        endpoint: "https://api.selftune.dev/api/v1/push",
        canonicalLogPath: "/nonexistent/canonical.jsonl",
      });
      expect(result.enrolled).toBe(true);
      expect(result.prepared).toBe(0);
    } finally {
      db.close();
    }
  });
});
