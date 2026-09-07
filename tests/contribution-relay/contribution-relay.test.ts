import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  flushCreatorContributionSignals,
  resolveContributionRelayApiKey,
  type FlushCreatorContributionSignalsOptions,
} from "../../packages/runtime/contribution-relay.js";
import { openDb } from "../../packages/runtime/localdb/db.js";
import type { CreatorContributionRelayPayload } from "../../packages/runtime/types/contribution-signals.js";

let db: ReturnType<typeof openDb>;
type RelayTransport = NonNullable<FlushCreatorContributionSignalsOptions["fetch"]>;

const stagedPayload = {
  version: 1,
  signal_type: "skill_session",
  source_key: "0123456789abcdef",
  relay_destination: "cr_search",
  skill_hash: "sk_sha256_abc123",
  user_cohort: "uc_sha256_123456",
  signals: { triggered: true, query_bucket: "comparison" },
  timestamp_bucket: "2026-W14",
  client_version: "0.4.0",
} satisfies CreatorContributionRelayPayload;

function seedStagedRow(skillName = "sc-search", status = "pending"): void {
  const now = "2026-04-01T00:00:00.000Z";
  db.run(
    `INSERT INTO creator_contribution_staging
       (dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at)
     VALUES (?, ?, 'cr_search', ?, ?, ?, ?)`,
    [`${skillName}-dedupe`, skillName, JSON.stringify(stagedPayload), status, now, now],
  );
}

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("contribution-relay", () => {
  test("dry-run reports pending rows without changing status", async () => {
    seedStagedRow();
    const request = mock<RelayTransport>(async () => {
      throw new Error("Dry runs must not upload");
    });

    const result = await flushCreatorContributionSignals(db, {
      dryRun: true,
      endpoint: "https://relay.example.test/v1/signals",
      fetch: request,
    });

    expect(result.dry_run).toBe(true);
    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    const row = db
      .query<{ status: string }, []>(
        `SELECT status FROM creator_contribution_staging WHERE skill_name = 'sc-search'`,
      )
      .get();
    expect(row?.status).toBe("pending");
    expect(request).not.toHaveBeenCalled();
  });

  test("flush uploads staged rows and marks them sent", async () => {
    seedStagedRow();
    const request = mock<RelayTransport>(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    );

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      fetch: request,
    });

    expect(result.attempted).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    const row = db
      .query<{ status: string; last_error: string | null }, []>(
        `SELECT status, last_error FROM creator_contribution_staging WHERE skill_name = 'sc-search'`,
      )
      .get();
    expect(row?.status).toBe("sent");
    expect(row?.last_error).toBeNull();
  });

  test("flush marks relay failures as failed", async () => {
    seedStagedRow();
    const request = mock<RelayTransport>(async () => new Response("bad request", { status: 400 }));

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      fetch: request,
    });

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    const row = db
      .query<{ status: string; last_error: string | null }, []>(
        `SELECT status, last_error FROM creator_contribution_staging WHERE skill_name = 'sc-search'`,
      )
      .get();
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toContain("HTTP 400");
  });

  test("requeues stale sending rows before flush", async () => {
    seedStagedRow("sc-search", "sending");
    const request = mock<RelayTransport>(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    );

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      fetch: request,
    });

    expect(result.requeued).toBe(1);
    expect(result.sent).toBe(1);
  });

  test("retry-failed requeues failed rows before flush", async () => {
    seedStagedRow("sc-search", "failed");
    const request = mock<RelayTransport>(
      async () => new Response(JSON.stringify({ status: "accepted" }), { status: 201 }),
    );

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      retryFailed: true,
      fetch: request,
    });

    expect(result.retried_failed).toBe(1);
    expect(result.sent).toBe(1);
  });

  test("resolveContributionRelayApiKey returns explicit key first", () => {
    expect(resolveContributionRelayApiKey("st_test_override")).toBe("st_test_override");
  });

  test.each([
    ["invalid JSON", "not-json"],
    ["null root", "null"],
    ["array root", "[]"],
    ["missing fields", "{}"],
    ["unsupported version", JSON.stringify({ ...stagedPayload, version: 2 })],
    ["string trigger", JSON.stringify({ ...stagedPayload, signals: { triggered: "yes" } })],
    ["unsupported grade", JSON.stringify({ ...stagedPayload, signals: { execution_grade: "S" } })],
  ])("rejects %s in the staged queue without uploading", async (_name, payloadJson) => {
    seedStagedRow();
    db.run("UPDATE creator_contribution_staging SET payload_json = ?", [payloadJson]);
    const request = mock<RelayTransport>(async () => new Response(null, { status: 204 }));

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      fetch: request,
    });

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(request).not.toHaveBeenCalled();
    const row = db
      .query<{ status: string; last_error: string | null }, []>(
        "SELECT status, last_error FROM creator_contribution_staging",
      )
      .get();
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toContain("Invalid staged creator contribution payload JSON");
  });

  test("uploads only the declared relay fields from saved evidence", async () => {
    seedStagedRow();
    db.run("UPDATE creator_contribution_staging SET payload_json = ?", [
      JSON.stringify({
        ...stagedPayload,
        raw_query: "private query",
        local_path: "/private/skill/SKILL.md",
        signals: { ...stagedPayload.signals, transcript: "private transcript" },
      }),
    ]);
    const request = mock<RelayTransport>(async () => new Response(null, { status: 204 }));

    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      fetch: request,
    });

    expect(result.sent).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0];
    expect(call?.[0]).toBe("https://relay.example.test/v1/signals");
    expect(call?.[1].body).toBe(JSON.stringify(stagedPayload));
    expect(new Headers(call?.[1].headers).get("Authorization")).toBe("Bearer st_test_123");
  });

  test.each([
    { status: 200, body: "not-json" },
    { status: 201, body: '{"status":"accepted"}' },
    { status: 204, body: null },
    { status: 409, body: '{"status":"duplicate"}' },
  ])("retains HTTP $status acceptance semantics", async ({ status, body }) => {
    seedStagedRow();
    const request = mock<RelayTransport>(async () => new Response(body, { status }));
    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      fetch: request,
    });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  test("records a transport failure without marking the staged row sent", async () => {
    seedStagedRow();
    const request = mock<RelayTransport>(async () => {
      throw new Error("Connection closed");
    });
    const result = await flushCreatorContributionSignals(db, {
      endpoint: "https://relay.example.test/v1/signals",
      apiKey: "st_test_123",
      fetch: request,
    });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    const row = db
      .query<{ status: string; last_error: string | null }, []>(
        "SELECT status, last_error FROM creator_contribution_staging",
      )
      .get();
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toBe("Connection closed");
  });
});
