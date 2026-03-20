/**
 * Tests for alpha upload status integration in `selftune status`
 * and alpha-related doctor checks in observability.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getLastUploadError,
  getLastUploadSuccess,
  getOldestPendingAge,
} from "../../cli/selftune/localdb/queries.js";
import { ALL_DDL } from "../../cli/selftune/localdb/schema.js";
import { checkAlphaQueueHealth } from "../../cli/selftune/observability.js";
import {
  type AlphaStatusInfo,
  type CloudVerifyData,
  fetchCloudVerify,
  formatAlphaStatus,
} from "../../cli/selftune/status.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  for (const ddl of ALL_DDL) {
    db.run(ddl);
  }
  return db;
}

function insertQueueItem(
  db: Database,
  opts: {
    payload_type?: string;
    status?: string;
    created_at?: string;
    updated_at?: string;
    last_error?: string | null;
    attempts?: number;
  } = {},
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO upload_queue (payload_type, payload_json, status, attempts, created_at, updated_at, last_error)
     VALUES (?, '{}', ?, ?, ?, ?, ?)`,
    [
      opts.payload_type ?? "sessions",
      opts.status ?? "pending",
      opts.attempts ?? 0,
      opts.created_at ?? now,
      opts.updated_at ?? now,
      opts.last_error ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Query helper tests
// ---------------------------------------------------------------------------

describe("getLastUploadError", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  test("returns null when no failed items exist", () => {
    const result = getLastUploadError(db);
    expect(result).toBeNull();
  });

  test("returns most recent failed item error and timestamp", () => {
    insertQueueItem(db, {
      status: "failed",
      last_error: "old error",
      updated_at: "2025-01-01T00:00:00Z",
    });
    insertQueueItem(db, {
      status: "failed",
      last_error: "newest error",
      updated_at: "2025-01-02T00:00:00Z",
    });
    insertQueueItem(db, {
      status: "sent",
      updated_at: "2025-01-03T00:00:00Z",
    });

    const result = getLastUploadError(db);
    expect(result).not.toBeNull();
    expect(result?.last_error).toBe("newest error");
    expect(result?.updated_at).toBe("2025-01-02T00:00:00Z");
  });
});

describe("getLastUploadSuccess", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  test("returns null when no sent items exist", () => {
    const result = getLastUploadSuccess(db);
    expect(result).toBeNull();
  });

  test("returns most recent sent item timestamp", () => {
    insertQueueItem(db, {
      status: "sent",
      updated_at: "2025-01-01T00:00:00Z",
    });
    insertQueueItem(db, {
      status: "sent",
      updated_at: "2025-01-02T00:00:00Z",
    });

    const result = getLastUploadSuccess(db);
    expect(result).not.toBeNull();
    expect(result?.updated_at).toBe("2025-01-02T00:00:00Z");
  });
});

describe("getOldestPendingAge", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  test("returns null when no pending items exist", () => {
    const result = getOldestPendingAge(db);
    expect(result).toBeNull();
  });

  test("returns age in seconds of oldest pending item", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000).toISOString();

    insertQueueItem(db, { status: "pending", created_at: twoHoursAgo });
    insertQueueItem(db, { status: "pending", created_at: oneHourAgo });

    const age = getOldestPendingAge(db);
    expect(age).not.toBeNull();
    // Should be approximately 7200 seconds (2 hours), allow some tolerance
    expect(age).toBeGreaterThan(7100);
    expect(age).toBeLessThan(7300);
  });

  test("ignores non-pending items", () => {
    const longAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    insertQueueItem(db, { status: "sent", created_at: longAgo });
    insertQueueItem(db, { status: "failed", created_at: longAgo });

    const result = getOldestPendingAge(db);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Doctor check tests
// ---------------------------------------------------------------------------

describe("checkAlphaQueueHealth", () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  test("returns empty array when not enrolled", async () => {
    const checks = await checkAlphaQueueHealth(db, false);
    expect(checks).toHaveLength(0);
  });

  test("returns pass checks when queue is healthy", async () => {
    const checks = await checkAlphaQueueHealth(db, true);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("warns when pending items older than 1 hour (alpha_queue_stuck)", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    insertQueueItem(db, { status: "pending", created_at: twoHoursAgo });

    const checks = await checkAlphaQueueHealth(db, true);
    const stuckCheck = checks.find((c) => c.name === "alpha_queue_stuck");
    expect(stuckCheck).toBeDefined();
    expect(stuckCheck?.status).toBe("warn");
  });

  test("passes when pending items are recent", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    insertQueueItem(db, { status: "pending", created_at: fiveMinutesAgo });

    const checks = await checkAlphaQueueHealth(db, true);
    const stuckCheck = checks.find((c) => c.name === "alpha_queue_stuck");
    expect(stuckCheck).toBeDefined();
    expect(stuckCheck?.status).toBe("pass");
  });

  test("warns when failed count exceeds 50 (alpha_queue_failures)", async () => {
    for (let i = 0; i < 51; i++) {
      insertQueueItem(db, { status: "failed", last_error: `error ${i}` });
    }

    const checks = await checkAlphaQueueHealth(db, true);
    const failCheck = checks.find((c) => c.name === "alpha_queue_failures");
    expect(failCheck).toBeDefined();
    expect(failCheck?.status).toBe("warn");
  });

  test("passes when failed count is under threshold", async () => {
    for (let i = 0; i < 10; i++) {
      insertQueueItem(db, { status: "failed", last_error: `error ${i}` });
    }

    const checks = await checkAlphaQueueHealth(db, true);
    const failCheck = checks.find((c) => c.name === "alpha_queue_failures");
    expect(failCheck).toBeDefined();
    expect(failCheck?.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Status formatting tests
// ---------------------------------------------------------------------------

describe("formatAlphaStatus", () => {
  test("returns 'not enrolled' line when not enrolled", () => {
    const output = formatAlphaStatus(null);
    expect(output).toContain("not enrolled");
    expect(output).toContain("Next command");
    expect(output).toContain("selftune init --alpha");
  });

  test("shows enrolled status with queue stats", () => {
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "ready",
      stats: { pending: 5, sending: 1, sent: 100, failed: 2 },
      lastError: { last_error: "network timeout", updated_at: "2025-01-15T10:00:00Z" },
      lastSuccess: { updated_at: "2025-01-15T09:00:00Z" },
    };
    const output = formatAlphaStatus(info);
    expect(output).toContain("enrolled");
    expect(output).toContain("5"); // pending
    expect(output).toContain("2"); // failed
    expect(output).toContain("100"); // sent
    expect(output).toContain("network timeout");
  });

  test("shows enrolled status with no errors", () => {
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "ready",
      stats: { pending: 0, sending: 0, sent: 50, failed: 0 },
      lastError: null,
      lastSuccess: { updated_at: "2025-01-15T09:00:00Z" },
    };
    const output = formatAlphaStatus(info);
    expect(output).toContain("enrolled");
    expect(output).not.toContain("error");
  });

  test("shows enrolled status with no successful uploads yet", () => {
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "ready",
      stats: { pending: 3, sending: 0, sent: 0, failed: 0 },
      lastError: null,
      lastSuccess: null,
    };
    const output = formatAlphaStatus(info);
    expect(output).toContain("enrolled");
    expect(output).toContain("3"); // pending
  });

  test("shows next command when enrollment is missing a credential", () => {
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "enrolled_no_credential",
      stats: { pending: 0, sending: 0, sent: 0, failed: 0 },
      lastError: null,
      lastSuccess: null,
    };

    const output = formatAlphaStatus(info);
    expect(output).toContain("Next command");
    expect(output).toContain("selftune init --alpha --force");
  });

  test("shows linked but not enrolled state when cloud identity exists", () => {
    const info: AlphaStatusInfo = {
      enrolled: false,
      linkState: "linked_not_enrolled",
      stats: { pending: 0, sending: 0, sent: 0, failed: 0 },
      lastError: null,
      lastSuccess: null,
    };

    const output = formatAlphaStatus(info);
    expect(output).toContain("Status:             not enrolled");
    expect(output).toContain("Cloud link:         linked (not enrolled)");
    expect(output).toContain("Next command");
  });

  test("shows cloud verification data when available", () => {
    const cloudVerify: CloudVerifyData = {
      enrolled: true,
      last_push_at: "2025-03-20T14:25:00Z",
      key_prefix: "st_live_abc",
      key_created_at: "2025-01-01T00:00:00Z",
      total_pushes: 12,
      last_push_status: "success",
    };
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "ready",
      stats: { pending: 0, sending: 0, sent: 47, failed: 0 },
      lastError: null,
      lastSuccess: { updated_at: "2025-03-20T14:25:00Z" },
      cloudVerify,
    };
    const output = formatAlphaStatus(info);
    expect(output).toContain("Cloud verified:");
    expect(output).toContain("yes");
    expect(output).toContain("Total pushes:");
    expect(output).toContain("12");
    expect(output).toContain("Last push:");
  });

  test("omits cloud verification lines when cloudVerify is null", () => {
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "ready",
      stats: { pending: 0, sending: 0, sent: 50, failed: 0 },
      lastError: null,
      lastSuccess: { updated_at: "2025-01-15T09:00:00Z" },
      cloudVerify: null,
    };
    const output = formatAlphaStatus(info);
    expect(output).toContain("enrolled");
    expect(output).not.toContain("Cloud verified:");
    expect(output).not.toContain("Total pushes:");
  });

  test("omits cloud verification lines when cloudVerify is undefined", () => {
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "ready",
      stats: { pending: 0, sending: 0, sent: 50, failed: 0 },
      lastError: null,
      lastSuccess: { updated_at: "2025-01-15T09:00:00Z" },
    };
    const output = formatAlphaStatus(info);
    expect(output).not.toContain("Cloud verified:");
  });

  test("shows cloud verification without last_push_at when null", () => {
    const cloudVerify: CloudVerifyData = {
      enrolled: true,
      last_push_at: null,
      key_prefix: "st_live_abc",
      key_created_at: "2025-01-01T00:00:00Z",
      total_pushes: 0,
      last_push_status: null,
    };
    const info: AlphaStatusInfo = {
      enrolled: true,
      linkState: "ready",
      stats: { pending: 0, sending: 0, sent: 0, failed: 0 },
      lastError: null,
      lastSuccess: null,
      cloudVerify,
    };
    const output = formatAlphaStatus(info);
    expect(output).toContain("Cloud verified:");
    expect(output).toContain("Total pushes:");
    expect(output).toContain("0");
    expect(output).not.toContain("Last push:");
  });
});

// ---------------------------------------------------------------------------
// fetchCloudVerify tests
// ---------------------------------------------------------------------------

describe("fetchCloudVerify", () => {
  test("returns null when endpoint is unreachable", async () => {
    // Point to a non-existent local server to simulate network failure
    const originalEnv = process.env.SELFTUNE_ALPHA_ENDPOINT;
    process.env.SELFTUNE_ALPHA_ENDPOINT = "http://127.0.0.1:19999/api/v1/push";
    try {
      const result = await fetchCloudVerify("st_live_test_key");
      expect(result).toBeNull();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SELFTUNE_ALPHA_ENDPOINT;
      } else {
        process.env.SELFTUNE_ALPHA_ENDPOINT = originalEnv;
      }
    }
  });
});
