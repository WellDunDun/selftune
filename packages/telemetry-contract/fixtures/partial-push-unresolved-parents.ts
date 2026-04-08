import type { PushPayloadV2 } from "../src/schemas.js";

/**
 * A valid PushPayloadV2 with invocations and prompts that reference a
 * session_id NOT present in the sessions array.
 *
 * Tests that the contract allows unresolved parent references -- the
 * session may have been pushed in a prior payload or may arrive later.
 */
export const partialPushUnresolvedParents: PushPayloadV2 = {
  schema_version: "2.0",
  client_version: "0.9.0",
  push_id: "c3d4e5f6-a7b8-8012-8def-123456789012",
  normalizer_version: "0.2.1",
  canonical: {
    sessions: [],
    prompts: [
      {
        record_kind: "prompt",
        schema_version: "2.0",
        normalizer_version: "0.2.1",
        normalized_at: "2026-03-19T11:00:00Z",
        platform: "claude_code",
        capture_mode: "replay",
        raw_source_ref: { path: "/tmp/raw/orphan-session.jsonl", line: 2 },
        source_session_kind: "replayed",
        session_id: "orphan-session-999",
        prompt_id: "orphan-prompt-001",
        occurred_at: "2026-03-19T10:30:00Z",
        prompt_text: "Refactor the database layer",
        prompt_kind: "user",
        is_actionable: true,
        prompt_index: 0,
      },
    ],
    skill_invocations: [
      {
        record_kind: "skill_invocation",
        schema_version: "2.0",
        normalizer_version: "0.2.1",
        normalized_at: "2026-03-19T11:00:00Z",
        platform: "claude_code",
        capture_mode: "replay",
        raw_source_ref: { path: "/tmp/raw/orphan-session.jsonl", line: 5 },
        source_session_kind: "replayed",
        session_id: "orphan-session-999",
        skill_invocation_id: "orphan-inv-001",
        occurred_at: "2026-03-19T10:31:00Z",
        matched_prompt_id: "orphan-prompt-001",
        skill_name: "db-refactor",
        invocation_mode: "inferred",
        triggered: true,
        confidence: 0.72,
      },
    ],
    execution_facts: [
      {
        record_kind: "execution_fact",
        schema_version: "2.0",
        normalizer_version: "0.2.1",
        normalized_at: "2026-03-19T11:00:00Z",
        platform: "claude_code",
        capture_mode: "replay",
        raw_source_ref: { path: "/tmp/raw/orphan-session.jsonl", line: 12 },
        source_session_kind: "replayed",
        session_id: "orphan-session-999",
        execution_fact_id: "orphan-ef-001",
        occurred_at: "2026-03-19T10:45:00Z",
        tool_calls_json: { Read: 8, Edit: 6, Bash: 4 },
        total_tool_calls: 18,
        assistant_turns: 7,
        errors_encountered: 1,
        duration_ms: 90000,
        completion_status: "completed",
      },
    ],
    normalization_runs: [],
  },
};
