import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  flushCreatorContributionSignals,
  resolveContributionRelayApiKey,
} from "../../cli/selftune/contribution-relay.js";
import { openDb } from "../../cli/selftune/localdb/db.js";

let db = openDb(":memory:");
const originalFetch = globalThis.fetch;

function seedStagedRow(skillName = "sc-search", status = "pending"): void {
  const now = "2026-04-01T00:00:00.000Z";
  db.run(
    `INSERT INTO creator_contribution_staging
       (dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at)
     VALUES (?, ?, 'cr_search', ?, ?, ?, ?)`,
    [
      `${skillName}-dedupe`,
      skillName,
      JSON.stringify({
        version: 1,
        signal_type: "skill_session",
        relay_destination: "cr_search",
        skill_hash: "sk_sha256_abc123",
        user_cohort: "uc_sha256_123456",
        signals: { triggered: true, query_bucket: "comparison" },
        timestamp_bucket: "2026-W14",
        client_version: "0.4.0",
      }),
      status,
      now,
      now,
    ],
  );
}

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  globalThis.fetch = originalFetch;
});

describe("contribution-relay", () => {
  test("dry-run reports pending rows without changing status", async () => {
    seedStagedRow();

    const result = await flushCreatorContributionSignals(db, {
      dryRun: true,
      endpoint: "https://relay.example.test/v1/signals",
    });

    expect(result.dry_run).toBe(true);
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    const row = db
      .query(`SELECT status FROM creator_contribution_staging WHERE skill_name = 'sc-search'`)
      .get() as { status: string } | null;
    expect(row?.status).toBe("pending");
  });

  test("flush uploads staged rows and marks them sent", async () => {
    seedStagedRow();
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    ) as typeof fetch;

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
    });

    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    const row = db
      .query(
        `SELECT status, last_error FROM creator_contribution_staging WHERE skill_name = 'sc-search'`,
      )
      .get() as { status: string; last_error: string | null } | null;
    expect(row?.status).toBe("sent");
    expect(row?.last_error).toBeNull();
  });

  test("flush marks relay failures as failed", async () => {
    seedStagedRow();
    globalThis.fetch = mock(
      async () => new Response("bad request", { status: 400 }),
    ) as typeof fetch;

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
    });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    const row = db
      .query(
        `SELECT status, last_error FROM creator_contribution_staging WHERE skill_name = 'sc-search'`,
      )
      .get() as { status: string; last_error: string | null } | null;
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toContain("HTTP 400");
  });

  test("requeues stale sending rows before flush", async () => {
    seedStagedRow("sc-search", "sending");
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    ) as typeof fetch;

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
    });

    expect(result.requeued).toBe(1);
    expect(result.sent).toBe(1);
  });

  test("retry-failed requeues failed rows before flush", async () => {
    seedStagedRow("sc-search", "failed");
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    ) as typeof fetch;

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      retryFailed: true,
    });

    expect(result.retried_failed).toBe(1);
    expect(result.sent).toBe(1);
  });

  test("resolveContributionRelayApiKey returns explicit key first", () => {
    expect(resolveContributionRelayApiKey("st_test_override")).toBe("st_test_override");
  });
});
