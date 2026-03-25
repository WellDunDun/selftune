/**
 * End-to-end integration tests for the alpha upload pipeline.
 *
 * Tests the full flow: staging -> enqueue -> flush -> status verification.
 * Uses an in-memory SQLite database and a mock HTTP endpoint via globalThis.fetch.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { QueueItem, QueueOperations } from "../../cli/selftune/alpha-upload-contract.js";
import { flushQueue } from "../../cli/selftune/alpha-upload/flush.js";
import { prepareUploads, runUploadCycle } from "../../cli/selftune/alpha-upload/index.js";
import {
  getPendingUploads,
  getQueueStats,
  readWatermark,
} from "../../cli/selftune/alpha-upload/queue.js";
import { getLastUploadError, getLastUploadSuccess } from "../../cli/selftune/localdb/queries.js";
import { ALL_DDL, MIGRATIONS, POST_MIGRATION_INDEXES } from "../../cli/selftune/localdb/schema.js";
import { checkAlphaQueueHealth } from "../../cli/selftune/observability.js";
import { type AlphaStatusInfo, formatAlphaStatus } from "../../cli/selftune/status.js";

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

/** Stage canonical session records directly into the staging table. */
function stageSessions(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    const sid = `e2e-session-${i}`;
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
    const pid = `e2e-prompt-${i}`;
    const record = {
      record_kind: "prompt",
      schema_version: "2.0",
      normalizer_version: "1.0.0",
      normalized_at: "2026-01-01T00:00:00.000Z",
      platform: "claude_code",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: {},
      session_id: "e2e-session-0",
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
      ["prompt", pid, JSON.stringify(record), "e2e-session-0", pid, new Date().toISOString()],
    );
  }
}

/** Stage evolution evidence records directly using V2 deterministic shape. */
function stageEvolutionEvidence(db: Database, count: number): void {
  for (let i = 0; i < count; i++) {
    const evidenceId = `ev_e2e-prop-${i}_deployed_${i}`;
    const recordId = `evidence-${evidenceId}:deployed:2026-01-01T00:00:00Z`;
    const record = {
      evidence_id: evidenceId,
      skill_name: "Research",
      proposal_id: `e2e-prop-${i}`,
      target: "description",
      stage: "deployed",
      rationale: "improved accuracy",
      confidence: 0.85,
      timestamp: "2026-01-01T00:00:00.000Z",
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

/** Build QueueOperations adapter from a db for flush engine. */
async function buildQueueOps(db: Database): Promise<QueueOperations> {
  const { markSending, markSent, markFailed } =
    await import("../../cli/selftune/alpha-upload/queue.js");
  return {
    getPending: (limit: number) => getPendingUploads(db, limit) as QueueItem[],
    markSending: (id: number) => markSending(db, [id]),
    markSent: (id: number) => markSent(db, [id]),
    markFailed: (id: number, error?: string) => markFailed(db, id, error ?? "unknown"),
  };
}

// ---------------------------------------------------------------------------
// E2E: Full pipeline flow
// ---------------------------------------------------------------------------

describe("e2e: full upload pipeline", () => {
  let db: Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it("stages records, enqueues, flushes to mock endpoint, and updates queue status", async () => {
    // Step 1: Stage sample records
    stageSessions(db, 3);
    stagePrompts(db, 2);
    stageEvolutionEvidence(db, 1);

    // Step 2: Prepare uploads (builds V2 payload and enqueues)
    const prepared = prepareUploads(
      db,
      "e2e-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(prepared.enqueued).toBe(1);
    expect(prepared.types).toContain("canonical");

    // Verify queue state after prepare
    const statsAfterPrepare = getQueueStats(db);
    expect(statsAfterPrepare.pending).toBe(1);
    expect(statsAfterPrepare.sent).toBe(0);

    // Step 3: Mock the HTTP endpoint to return success
    let postedPayload: Record<string, unknown> | null = null;
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      postedPayload = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ success: true, push_id: "test-push-id", errors: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // Step 4: Flush the queue
    const queueOps = await buildQueueOps(db);
    const flush = await flushQueue(queueOps, "https://mock.selftune.dev/api/v1/push", {
      apiKey: "test-api-key-123",
    });

    expect(flush.sent).toBe(1);
    expect(flush.failed).toBe(0);

    // Step 5: Verify the HTTP request was correct
    expect(postedPayload).not.toBeNull();
    expect((postedPayload as Record<string, unknown>).schema_version).toBe("2.0");
    expect((postedPayload as Record<string, unknown>).push_id).toBeDefined();
    expect((postedPayload as Record<string, unknown>).canonical).toBeDefined();
    expect(capturedHeaders.authorization).toBe("Bearer test-api-key-123");
    expect(capturedHeaders["content-type"]).toBe("application/json");

    // Step 6: Verify queue status updated to sent
    const statsAfterFlush = getQueueStats(db);
    expect(statsAfterFlush.pending).toBe(0);
    expect(statsAfterFlush.sent).toBe(1);

    // Step 7: Verify watermark advanced
    const watermark = readWatermark(db, "canonical");
    expect(watermark).not.toBeNull();
    expect(watermark ?? 0).toBeGreaterThan(0);

    // Step 8: Running again with no new records produces no new uploads
    const secondPrepare = prepareUploads(
      db,
      "e2e-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(secondPrepare.enqueued).toBe(0);
  });

  it("runUploadCycle handles the full cycle end-to-end", async () => {
    // Stage records first
    stageSessions(db, 2);

    // Mock successful endpoint
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ success: true, push_id: "cycle-push-id", errors: [] }), {
        status: 200,
      });
    });

    // Run the full cycle
    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "cycle-key-abc",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(result.enrolled).toBe(true);
    expect(result.prepared).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Verify queue is clean
    const stats = getQueueStats(db);
    expect(stats.pending).toBe(0);
    expect(stats.sent).toBe(1);

    // Running again produces no new uploads
    const secondRun = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "cycle-key-abc",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(secondRun.prepared).toBe(0);
    expect(secondRun.sent).toBe(0);
  });

  it("dry-run mode does not send HTTP requests", async () => {
    stageSessions(db, 2);

    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    });

    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      dryRun: true,
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(result.enrolled).toBe(true);
    expect(result.prepared).toBe(1);
    expect(result.sent).toBe(0);
    expect(fetchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E: Failure scenarios
// ---------------------------------------------------------------------------

describe("e2e: failure scenarios", () => {
  let db: Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it("auth failure (401) marks items as failed with descriptive message", async () => {
    stageSessions(db, 1);

    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    });

    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "bad-key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(result.enrolled).toBe(true);
    expect(result.prepared).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);

    // Check error message recorded
    const lastError = getLastUploadError(db);
    expect(lastError).not.toBeNull();
    expect(lastError?.last_error).toContain("Authentication failed");
  });

  it("auth failure (403) marks items as failed with permission message", async () => {
    stageSessions(db, 1);

    globalThis.fetch = mock(async () => {
      return new Response("Forbidden", { status: 403 });
    });

    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "forbidden-key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(result.failed).toBe(1);
    const lastError = getLastUploadError(db);
    expect(lastError?.last_error).toContain("Authorization denied");
  });

  it("network-unreachable endpoint keeps records in queue with failure status", async () => {
    stageSessions(db, 1);

    globalThis.fetch = mock(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    });

    // Prepare manually so we can control flush options (maxRetries=1 to skip backoff)
    const prepared = prepareUploads(
      db,
      "e2e-user",
      "claude_code",
      "0.2.7",
      "/nonexistent/canonical.jsonl",
    );
    expect(prepared.enqueued).toBe(1);

    // Flush with maxRetries=1 to avoid exponential backoff timeout
    const queueOps = await buildQueueOps(db);
    const flush = await flushQueue(queueOps, "http://localhost:1/nonexistent", {
      apiKey: "test-key",
      maxRetries: 1,
    });

    expect(flush.failed).toBe(1);
    expect(flush.sent).toBe(0);

    // Error recorded in queue
    const lastError = getLastUploadError(db);
    expect(lastError).not.toBeNull();
    expect(lastError?.last_error).toContain("exhausted retries");
  });

  it("409 conflict is treated as success (duplicate push_id)", async () => {
    stageSessions(db, 1);

    globalThis.fetch = mock(async () => {
      return new Response("Conflict: duplicate push_id", { status: 409 });
    });

    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "test-key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    const stats = getQueueStats(db);
    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it("second run picks up where first left off (watermark persistence)", async () => {
    // Stage 3 sessions
    stageSessions(db, 3);

    // First run: mock success
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ success: true, push_id: "run1", errors: [] }), {
        status: 200,
      });
    });

    const firstRun = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "test-key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(firstRun.prepared).toBe(1);
    expect(firstRun.sent).toBe(1);
    const watermarkAfterFirst = readWatermark(db, "canonical");

    // Add more records AFTER the first run
    for (let i = 100; i < 103; i++) {
      const sid = `e2e-session-${i}`;
      const record = {
        record_kind: "session",
        schema_version: "2.0",
        normalizer_version: "1.0.0",
        normalized_at: "2026-01-02T00:00:00.000Z",
        platform: "claude_code",
        capture_mode: "replay",
        source_session_kind: "interactive",
        raw_source_ref: {},
        session_id: sid,
        started_at: "2026-01-02T00:00:00.000Z",
        ended_at: "2026-01-02T01:00:00.000Z",
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

    // Second run: should only pick up the new records
    const secondRun = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "test-key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(secondRun.prepared).toBe(1);
    expect(secondRun.sent).toBe(1);

    // Watermark should have advanced further
    const watermarkAfterSecond = readWatermark(db, "canonical");
    expect(watermarkAfterSecond).not.toBeNull();
    expect(watermarkAfterSecond ?? 0).toBeGreaterThan(watermarkAfterFirst ?? 0);

    // Queue should show 2 sent total
    const stats = getQueueStats(db);
    expect(stats.sent).toBe(2);
  });

  it("missing API key still enqueues but flush fails with auth error", async () => {
    stageSessions(db, 1);

    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    });

    // Run without API key
    const result = await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      // no apiKey
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    // Records were prepared/enqueued
    expect(result.prepared).toBe(1);
    // But flush failed due to 401
    expect(result.failed).toBe(1);
  });

  it("unenrolled user gets empty summary without any network calls", async () => {
    stageSessions(db, 5);

    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    });

    const result = await runUploadCycle(db, {
      enrolled: false,
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    expect(result.enrolled).toBe(false);
    expect(result.prepared).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(fetchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E: Observability and status visibility
// ---------------------------------------------------------------------------

describe("e2e: status visibility after uploads", () => {
  let db: Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createTestDb();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it("queue stats reflect accurate counts after mixed success/failure uploads", async () => {
    // Stage and run a successful upload
    stageSessions(db, 1);

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ success: true, push_id: "ok", errors: [] }), {
        status: 200,
      });
    });

    await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    // Now stage and run a failed upload
    for (let i = 10; i < 11; i++) {
      const sid = `e2e-session-${i}`;
      db.run(
        `INSERT OR IGNORE INTO canonical_upload_staging
          (record_kind, record_id, record_json, session_id, staged_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          "session",
          sid,
          JSON.stringify({
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
          }),
          sid,
          new Date().toISOString(),
        ],
      );
    }

    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    });

    await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "bad-key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    // Verify stats
    const stats = getQueueStats(db);
    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(0);

    // Verify last error/success queries
    const lastError = getLastUploadError(db);
    expect(lastError).not.toBeNull();
    expect(lastError?.last_error).toContain("Authentication failed");

    const lastSuccess = getLastUploadSuccess(db);
    expect(lastSuccess).not.toBeNull();
  });

  it("formatAlphaStatus renders correctly with live queue data", async () => {
    // Populate queue with mixed statuses
    stageSessions(db, 2);

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ success: true, push_id: "ok", errors: [] }), {
        status: 200,
      });
    });

    await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    // Build status info from real queue data
    const info: AlphaStatusInfo = {
      enrolled: true,
      stats: getQueueStats(db),
      lastError: getLastUploadError(db),
      lastSuccess: getLastUploadSuccess(db),
    };

    const output = formatAlphaStatus(info);
    expect(output).toContain("enrolled");
    expect(output).toContain("Sent:");

    // Check sent count appears in output
    expect(info.stats.sent).toBe(1);
  });

  it("doctor checks detect stuck items after failed upload", async () => {
    // Insert an old pending item to simulate a stuck upload
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    db.run(
      `INSERT INTO upload_queue (payload_type, payload_json, status, attempts, created_at, updated_at)
       VALUES (?, '{}', 'pending', 0, ?, ?)`,
      ["push", twoHoursAgo, twoHoursAgo],
    );

    const checks = await checkAlphaQueueHealth(db, true);
    const stuckCheck = checks.find((c) => c.name === "alpha_queue_stuck");
    expect(stuckCheck).toBeDefined();
    expect(stuckCheck?.status).toBe("warn");
    expect(stuckCheck?.message).toContain("old");
  });

  it("doctor checks pass when queue is healthy after successful upload", async () => {
    stageSessions(db, 1);

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ success: true, push_id: "ok", errors: [] }), {
        status: 200,
      });
    });

    await runUploadCycle(db, {
      enrolled: true,
      userId: "e2e-user",
      agentType: "claude_code",
      selftuneVersion: "0.2.7",
      endpoint: "https://mock.selftune.dev/api/v1/push",
      apiKey: "key",
      canonicalLogPath: "/nonexistent/canonical.jsonl",
    });

    const checks = await checkAlphaQueueHealth(db, true);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });
});
