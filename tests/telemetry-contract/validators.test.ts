import { describe, expect, test } from "bun:test";
import {
  CANONICAL_SCHEMA_VERSION,
  isCanonicalRecord,
} from "../../packages/telemetry-contract/index.js";

describe("telemetry contract validators", () => {
  test("accepts a valid canonical prompt record", () => {
    expect(
      isCanonicalRecord({
        record_kind: "prompt",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-10T10:00:00.000Z",
        platform: "claude_code",
        capture_mode: "hook",
        source_session_kind: "interactive",
        session_id: "sess-1",
        raw_source_ref: { event_type: "UserPromptSubmit" },
        prompt_id: "sess-1:p0",
        occurred_at: "2026-03-10T10:00:00.000Z",
        prompt_text: "Build the landing page",
        prompt_kind: "user",
        is_actionable: true,
      }),
    ).toBe(true);
  });

  test("rejects malformed canonical records", () => {
    expect(
      isCanonicalRecord({
        record_kind: "prompt",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-10T10:00:00.000Z",
        platform: "claude_code",
        capture_mode: "hook",
        source_session_kind: "interactive",
        session_id: "sess-1",
        raw_source_ref: { event_type: "UserPromptSubmit" },
        prompt_id: "sess-1:p0",
        occurred_at: "2026-03-10T10:00:00.000Z",
        prompt_text: "Build the landing page",
        prompt_kind: "not-a-kind",
        is_actionable: true,
      }),
    ).toBe(false);
  });

  test("accepts normalization_run without fabricated session scope", () => {
    expect(
      isCanonicalRecord({
        record_kind: "normalization_run",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-10T10:00:00.000Z",
        platform: "claude_code",
        capture_mode: "repair",
        raw_source_ref: { event_type: "repair-skill-usage" },
        run_id: "norm-run-1",
        run_at: "2026-03-10T10:00:00.000Z",
        raw_records_seen: 12,
        canonical_records_written: 8,
        repair_applied: true,
      }),
    ).toBe(true);
  });

  test("rejects malformed nested telemetry values", () => {
    expect(
      isCanonicalRecord({
        record_kind: "skill_invocation",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-10T10:00:00.000Z",
        platform: "claude_code",
        capture_mode: "hook",
        source_session_kind: "interactive",
        session_id: "sess-1",
        raw_source_ref: { event_type: "PostToolUse" },
        skill_invocation_id: "sess-1:s:test:0",
        occurred_at: "2026-03-10T10:00:00.000Z",
        skill_name: "test",
        invocation_mode: "explicit",
        triggered: true,
        confidence: Number.NaN,
      }),
    ).toBe(false);

    expect(
      isCanonicalRecord({
        record_kind: "execution_fact",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-10T10:00:00.000Z",
        platform: "claude_code",
        capture_mode: "hook",
        source_session_kind: "interactive",
        session_id: "sess-1",
        raw_source_ref: { event_type: "Stop" },
        occurred_at: "2026-03-10T10:00:00.000Z",
        tool_calls_json: { Bash: "3" },
        total_tool_calls: 3,
        bash_commands_redacted: [123],
        assistant_turns: 1,
        errors_encountered: 0,
      }),
    ).toBe(false);
  });
});
