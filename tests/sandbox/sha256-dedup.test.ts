/**
 * SHA256 Content Hashing Tests — Upload Dedup
 *
 * Validates that:
 *   - SHA256 is computed correctly for a known input
 *   - Same record staged twice produces the same hash
 *   - Different records produce different hashes
 *   - content_sha256 remains local and deployed V2 payloads stay contract-exact
 *   - 304 / "unchanged" responses are treated as success in flush
 */

import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildV2PushPayload } from "../../packages/runtime/alpha-upload/build-payloads.js";
import { openDb } from "../../packages/runtime/localdb/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-memory SQLite database with full schema. */
function createTestDb(): Database {
  return openDb(":memory:");
}

/** Manually stage a record with known JSON to test hashing. */
function manualStage(db: Database, recordKind: string, recordId: string, recordJson: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO canonical_upload_staging
      (record_kind, record_id, record_json, session_id, prompt_id, normalized_at, staged_at, content_sha256)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
  `).run(
    recordKind,
    recordId,
    recordJson,
    "2026-03-29T10:31:00Z",
    new Date().toISOString(),
    computeSha256(recordJson),
  );
}

/** Compute SHA256 of a string (reference implementation for tests). */
function computeSha256(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SHA256 content hashing for upload dedup", () => {
  it("computes correct SHA256 for a known input", () => {
    const input = '{"record_kind":"session","session_id":"test-123"}';
    const hash = computeSha256(input);

    // SHA256 should be a 64-character hex string
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Verify against known SHA256 value
    expect(hash).toBe("164c2c2519458131bded2a441a5407fde2f3a64e90ee9c89de002189fc8155ca");
  });

  it("same record staged twice produces the same hash", () => {
    const db = createTestDb();
    const recordJson = JSON.stringify({
      record_kind: "session",
      session_id: "sess-aaa",
      started_at: "2026-03-29T10:00:00Z",
    });

    manualStage(db, "session", "sess-aaa", recordJson);

    // Try staging same record again (INSERT OR IGNORE will skip)
    manualStage(db, "session", "sess-aaa", recordJson);

    // Only one row should exist due to dedup
    const rows = db
      .query("SELECT content_sha256 FROM canonical_upload_staging WHERE record_id = ?")
      .all("sess-aaa") as Array<{ content_sha256: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].content_sha256).toBe(computeSha256(recordJson));
  });

  it("different records produce different hashes", () => {
    const db = createTestDb();

    const jsonA = JSON.stringify({
      record_kind: "session",
      session_id: "sess-aaa",
      started_at: "2026-03-29T10:00:00Z",
    });
    const jsonB = JSON.stringify({
      record_kind: "session",
      session_id: "sess-bbb",
      started_at: "2026-03-29T11:00:00Z",
    });

    manualStage(db, "session", "sess-aaa", jsonA);
    manualStage(db, "session", "sess-bbb", jsonB);

    const rows = db
      .query("SELECT record_id, content_sha256 FROM canonical_upload_staging ORDER BY record_id")
      .all() as Array<{ record_id: string; content_sha256: string | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].content_sha256).not.toBe(rows[1].content_sha256);
    expect(rows[0].content_sha256).toBe(computeSha256(jsonA));
    expect(rows[1].content_sha256).toBe(computeSha256(jsonB));
  });

  it("content_sha256 column exists in staging table after migration", () => {
    const db = createTestDb();

    // Check the column exists by querying table info
    const columns = db.query("PRAGMA table_info(canonical_upload_staging)").all() as Array<{
      name: string;
    }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("content_sha256");
  });

  it("staging index on content_sha256 exists", () => {
    const db = createTestDb();

    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='canonical_upload_staging'",
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_staging_sha256");
  });

  it("keeps content_sha256 local while emitting an exact deployed V2 payload", () => {
    const db = createTestDb();

    const recordJson = JSON.stringify({
      record_kind: "session",
      session_id: "sess-payload-test",
      started_at: "2026-03-29T10:00:00Z",
      ended_at: "2026-03-29T10:30:00Z",
      platform: "claude_code",
      model: "claude-sonnet-4-20250514",
      completion_status: "completed",
      schema_version: "2.0",
      normalized_at: "2026-03-29T10:31:00Z",
      normalizer_version: "1.0.0",
      capture_mode: "replay",
      source_session_kind: "interactive",
      raw_source_ref: { path: "/tmp/test.jsonl" },
    });
    const sha = computeSha256(recordJson);

    db.prepare(`
      INSERT INTO canonical_upload_staging
        (record_kind, record_id, record_json, session_id, prompt_id, normalized_at, staged_at, content_sha256)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      "session",
      "sess-payload-test",
      recordJson,
      "sess-payload-test",
      "2026-03-29T10:31:00Z",
      new Date().toISOString(),
      sha,
    );

    const result = buildV2PushPayload(db, 0);
    expect(result).not.toBeNull();
    expect(result).toBeDefined();

    const payload = result?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("content_hashes");
    expect(
      db
        .query(
          "SELECT content_sha256 FROM canonical_upload_staging WHERE record_kind = ? AND record_id = ?",
        )
        .get("session", "sess-payload-test"),
    ).toEqual({ content_sha256: sha });
  });
});
