import { describe, expect, test } from "bun:test";

import { validateRecord } from "../../cli/selftune/utils/schema-validator.js";

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
