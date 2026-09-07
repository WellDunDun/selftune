import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { buildCanonicalRecordsFromOpenCode } from "@selftune/harness-opencode/ingestors/opencode-canonical";
import { buildLocalTelemetryBatchFromRollout } from "@selftune/harness-codex/ingestors/codex-trace-projection";
import type { ParsedSession } from "@selftune/harness-opencode/ingestors/opencode-ingest";
import type { ParsedRollout } from "@selftune/harness-codex/ingestors/codex-rollout";

const source: ParsedSession = {
  timestamp: "2026-09-06T00:00:00.000Z",
  session_id: "source",
  source: "opencode",
  transcript_path: "/private/source",
  cwd: "/private/project",
  last_user_query: "Review the report",
  query: "Review the report",
  tool_calls: {},
  total_tool_calls: 0,
  bash_commands: [],
  skills_triggered: [],
  assistant_turns: 1,
  errors_encountered: 0,
  transcript_chars: 10,
};

test("OpenCode keeps absent token measurements distinct from measured zero", () => {
  const absent = buildCanonicalRecordsFromOpenCode(source);
  const session = absent.find((record) => record.record_kind === "session");
  const execution = absent.find((record) => record.record_kind === "execution_fact");
  expect(session).toBeDefined();
  expect(execution).toBeDefined();
  assert(session && execution);
  for (const key of ["ended_at", "provider", "model"])
    expect(Object.hasOwn(session, key)).toBe(false);
  expect(Object.hasOwn(execution, "input_tokens")).toBe(false);
  expect(Object.hasOwn(execution, "output_tokens")).toBe(false);
  const measured = buildCanonicalRecordsFromOpenCode({
    ...source,
    input_tokens: 0,
    output_tokens: 0,
    model: "test-model",
    model_provider: "provider",
    source_ended_at: "2026-09-06T00:00:01.000Z",
  });
  expect(measured.find((record) => record.record_kind === "session")).toMatchObject({
    model: "test-model",
    provider: "provider",
    ended_at: "2026-09-06T00:00:01.000Z",
  });
  expect(measured.find((record) => record.record_kind === "execution_fact")).toMatchObject({
    input_tokens: 0,
    output_tokens: 0,
  });
  expect(
    buildCanonicalRecordsFromOpenCode({ ...source, is_metadata_only: true }).some(
      (record) => record.record_kind === "execution_fact",
    ),
  ).toBe(false);
});

test("Codex emits model metadata only when the source supplies it", () => {
  const rollout: ParsedRollout = {
    ...source,
    source: "codex_rollout",
    rollout_path: "/private/rollout",
    started_at: source.timestamp,
    ended_at: "2026-09-06T00:00:01.000Z",
    actionable_prompt_count: 1,
    skills_invoked: [],
    skill_evidence: {},
    input_tokens: 0,
    output_tokens: 0,
  };
  const withoutMetadata = buildLocalTelemetryBatchFromRollout(rollout);
  expect(withoutMetadata?.spans).toHaveLength(1);
  const span = withoutMetadata?.spans[0];
  assert(span);
  expect(Object.hasOwn(span, "provider")).toBe(false);
  expect(Object.hasOwn(span, "model")).toBe(false);
  const withMetadata = buildLocalTelemetryBatchFromRollout({
    ...rollout,
    observed_meta: { model_provider: "provider", model: "test-model" },
  });
  expect(withMetadata?.spans[0]).toMatchObject({ provider: "provider", model: "test-model" });
  expect(JSON.stringify(withMetadata)).not.toContain("/private/");
});
