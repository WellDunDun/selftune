import { expect, test } from "bun:test";
import { buildLocalTelemetryBatchFromSession } from "@selftune/harness-claude-code/ingestors/claude-trace-projection";
import { buildLocalTelemetryBatchFromOpenCode } from "@selftune/harness-opencode/ingestors/opencode-trace-projection";
import { buildLocalTelemetryBatchFromPiSession } from "@selftune/harness-pi/ingestors/pi-trace-projection";

const timestamp = "2026-07-23T10:00:00.000Z";
const endedAt = "2026-07-23T10:00:05.000Z";
const metrics = {
  tool_calls: {},
  total_tool_calls: 2.9,
  bash_commands: [],
  skills_triggered: [],
  assistant_turns: 1,
  errors_encountered: -1,
  transcript_chars: 10,
  last_user_query: "private prompt",
  input_tokens: Number.NaN,
  output_tokens: Number.POSITIVE_INFINITY,
};

function project(model: string | undefined, provider: string | undefined) {
  const common = {
    ...metrics,
    timestamp,
    session_id: "metadata-contract",
    transcript_path: "/private/source",
    cwd: "/private",
    query: "private prompt",
    model,
  };
  return [
    buildLocalTelemetryBatchFromSession({
      timestamp,
      session_id: common.session_id,
      transcript_path: common.transcript_path,
      user_queries: [],
      metrics: { ...metrics, started_at: timestamp, ended_at: endedAt, model },
    }),
    buildLocalTelemetryBatchFromOpenCode({
      ...common,
      source: "opencode",
      source_ended_at: endedAt,
      model_provider: provider,
    }),
    buildLocalTelemetryBatchFromPiSession({ ...common, source: "pi", ended_at: endedAt, provider }),
  ];
}

test.each([
  { model: undefined, provider: undefined },
  { model: "", provider: "" },
  { model: "test-model", provider: undefined },
  { model: undefined, provider: "test-provider" },
  { model: "test-model", provider: "test-provider" },
])("preserves optional source metadata and stable identities: %j", ({ model, provider }) => {
  const baseline = project(undefined, undefined);
  for (const [index, batch] of project(model, provider).entries()) {
    const span = batch.spans[0];
    expect(span).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      error_count: 0,
      tool_call_count: 2,
    });
    expect(batch.batch_id).toBe(baseline[index].batch_id);
    expect(span.trace_id).toBe(baseline[index].spans[0].trace_id);
    expect(span.span_id).toBe(baseline[index].spans[0].span_id);
    if (model) expect(span.model).toBe(model);
    else expect(span).not.toHaveProperty("model");
    if (index > 0 && provider) expect(span.provider).toBe(provider);
    else expect(span).not.toHaveProperty("provider");
    expect(JSON.stringify(batch)).not.toContain("private");
  }
});
