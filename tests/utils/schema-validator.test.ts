import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "../../cli/selftune/utils/jsonl.js";
import { validateRecord } from "../../cli/selftune/utils/schema-validator.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-schema-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateRecord", () => {
  test("valid session_telemetry record passes validation", () => {
    const record = {
      timestamp: "2026-02-28T12:00:00Z",
      session_id: "sess-001",
      source: "claude",
    };
    const result = validateRecord(record, "session_telemetry");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("valid skill_usage record passes validation", () => {
    const record = {
      timestamp: "2026-02-28T12:00:00Z",
      session_id: "sess-002",
      skill_name: "code-review",
    };
    const result = validateRecord(record, "skill_usage");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("valid all_queries record passes validation", () => {
    const record = {
      timestamp: "2026-02-28T12:00:00Z",
      session_id: "sess-003",
      query: "How do I refactor this?",
    };
    const result = validateRecord(record, "all_queries");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("missing timestamp field produces error", () => {
    const record = {
      session_id: "sess-004",
      source: "claude",
    };
    const result = validateRecord(record, "session_telemetry");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes("timestamp"))).toBe(true);
  });

  test("missing session_id field produces error", () => {
    const record = {
      timestamp: "2026-02-28T12:00:00Z",
      source: "claude",
    };
    const result = validateRecord(record, "session_telemetry");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes("session_id"))).toBe(true);
  });

  test("missing query field for all_queries produces error", () => {
    const record = {
      timestamp: "2026-02-28T12:00:00Z",
      session_id: "sess-005",
    };
    const result = validateRecord(record, "all_queries");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes("query"))).toBe(true);
  });

  test("missing skill_name field for skill_usage produces error", () => {
    const record = {
      timestamp: "2026-02-28T12:00:00Z",
      session_id: "sess-006",
    };
    const result = validateRecord(record, "skill_usage");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes("skill_name"))).toBe(true);
  });

  test("timestamp as number (wrong type) produces error", () => {
    const record = {
      timestamp: 1234567890,
      session_id: "sess-007",
      source: "claude",
    };
    const result = validateRecord(record, "session_telemetry");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes("timestamp"))).toBe(true);
    expect(result.errors.some((e) => e.includes("string"))).toBe(true);
  });

  test("empty object produces multiple errors", () => {
    const record = {};
    const result = validateRecord(record, "session_telemetry");
    expect(result.valid).toBe(false);
    // session_telemetry requires timestamp, session_id, source
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  test("extra fields are allowed (no error for unknown keys)", () => {
    const record = {
      timestamp: "2026-02-28T12:00:00Z",
      session_id: "sess-008",
      source: "claude",
      extra_field: "some-value",
      another: 42,
    };
    const result = validateRecord(record, "session_telemetry");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("non-object record produces error", () => {
    const result = validateRecord("not-an-object", "session_telemetry");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  test("null record produces error", () => {
    const result = validateRecord(null, "session_telemetry");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("appendJsonl with logType (fail-open validation)", () => {
  test("appendJsonl with logType still writes invalid records (fail-open)", () => {
    const path = join(tmpDir, "failopen.jsonl");
    // Record missing required 'source' field for session_telemetry
    const invalidRecord = { timestamp: "2026-02-28T12:00:00Z", session_id: "sess-009" };
    appendJsonl(path, invalidRecord, "session_telemetry");
    // Record should still be written despite validation failure
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.timestamp).toBe("2026-02-28T12:00:00Z");
    expect(parsed.session_id).toBe("sess-009");
  });

  test("appendJsonl without logType writes without validation (backward compatible)", () => {
    const path = join(tmpDir, "compat.jsonl");
    const record = { anything: "goes", no_schema: true };
    // Should write without any validation, no errors
    appendJsonl(path, record);
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.anything).toBe("goes");
    expect(parsed.no_schema).toBe(true);
  });

  test("appendJsonl with logType writes valid records normally", () => {
    const path = join(tmpDir, "valid.jsonl");
    const validRecord = {
      timestamp: "2026-02-28T12:00:00Z",
      session_id: "sess-010",
      source: "claude",
    };
    appendJsonl(path, validRecord, "session_telemetry");
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.timestamp).toBe("2026-02-28T12:00:00Z");
    expect(parsed.source).toBe("claude");
  });
});
