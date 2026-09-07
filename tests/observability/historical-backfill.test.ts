import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import {
  HistoricalBackfillInput,
  normalizeHistoricalBackfill,
} from "../../packages/observability/src/historical-backfill.js";

const normalize = (input: typeof HistoricalBackfillInput.Encoded) =>
  Effect.runPromise(normalizeHistoricalBackfill(input));
const session = {
  session_id: "session-1",
  platform: "codex" as const,
  started_at: "2026-07-23T10:00:00.000Z",
  ended_at: "2026-07-23T10:02:00.000Z",
  raw_source_ref: "file:///safe/session.jsonl",
};

const base = {
  source_cursor: "__start__",
  source_revision: "sqlite-r1",
  source_domain: "skill_invocations" as const,
  include_session_spans: false,
  sessions: [session],
  prompts: [],
  skill_invocations: [
    {
      skill_invocation_id: "invocation-1",
      session_id: "session-1",
      skill_name: "diagnose",
      occurred_at: "2026-07-23T10:01:00.000Z",
      raw_source_ref: "file:///safe/invocation.jsonl",
      query: "private query is ignored",
    },
  ],
  execution_facts: [],
};

describe("historical backfill normalization", () => {
  test("keeps historical skill observations as metadata logs with stable provenance", async () => {
    const result = await normalize(base);
    expect(result.imports[0]?.source_revision).toBe(
      "9ae281f6ef5a4919670560d7ee75f5ddf404c0c617edbc45b779d46c7eadd08b",
    );
    const batch = result.imports[0]!.batch;
    expect(batch.spans).toEqual([]);
    expect(batch.logs?.[0]).toMatchObject({
      event_name: "historical.skill_invocation_observed",
      source_id: "skill_invocation:invocation-1",
      evidence_quality: "metadata_only",
      source_reference: "file:///safe/invocation.jsonl",
    });
    expect(batch.log_skill_links?.[0]).toMatchObject({
      skill_invocation_id: "invocation-1",
    });
    expect(JSON.stringify(result)).not.toContain("private query");
  });

  test("withholds missing point timestamps and never infers a session-start event", async () => {
    const result = await normalize({
      ...base,
      skill_invocations: [
        {
          skill_invocation_id: "invocation-1",
          session_id: "session-1",
          skill_name: "diagnose",
        },
      ],
    });
    expect(result.imports).toEqual([]);
    expect(result.withheld).toContainEqual({
      source_id: "skill_invocation:invocation-1",
      reason: "missing_timestamp",
    });
  });

  test("is deterministic across source order and retains latest cumulative snapshots", async () => {
    const facts = [
      {
        execution_fact_id: "fact-1",
        session_id: "session-1",
        occurred_at: "2026-07-23T10:00:30.000Z",
        input_tokens: 10,
        duration_ms: 1_000,
        raw_source_ref: "file:///safe/fact.jsonl",
      },
      {
        execution_fact_id: "fact-1",
        session_id: "session-1",
        occurred_at: "2026-07-23T10:01:30.000Z",
        input_tokens: 20,
        duration_ms: 2_000,
        raw_source_ref: "file:///safe/fact.jsonl",
      },
    ];
    const input = {
      ...base,
      source_domain: "execution_facts" as const,
      execution_facts: facts,
    };
    const [forward, reverse] = await Promise.all([
      normalize(input),
      normalize({ ...input, execution_facts: facts.toReversed() }),
    ]);
    expect(reverse).toEqual(forward);
    expect(forward.imports[0]!.batch.metric_points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "input_tokens",
          value: 20,
          temporality: "cumulative",
        }),
      ]),
    );
  });

  test("keeps every output collection within 256 facts", async () => {
    const execution_facts = Array.from({ length: 60 }, (_, index) => ({
      execution_fact_id: `fact-${index}`,
      session_id: "session-1",
      occurred_at: "2026-07-23T10:01:00.000Z",
      input_tokens: index,
      output_tokens: index,
      total_tool_calls: index,
      errors_encountered: index,
      duration_ms: index,
    }));
    const result = await normalize({
      ...base,
      source_domain: "execution_facts",
      execution_facts,
    });
    expect(result.imports.length).toBeGreaterThan(1);
    for (const request of result.imports) {
      expect(request.batch.spans.length).toBeLessThanOrEqual(256);
      expect(request.batch.logs?.length ?? 0).toBeLessThanOrEqual(256);
      expect(request.batch.metric_points?.length ?? 0).toBeLessThanOrEqual(256);
    }
  });
});
