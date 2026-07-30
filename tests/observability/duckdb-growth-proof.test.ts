import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDbAnalyticalStore } from "@selftune/observability/duckdb-store";
import { makeDuckDbNodeApiAnalyticalStoreLive } from "@selftune/observability/duckdb-node-api";
import * as Effect from "effect/Effect";

const temporaryDirectories: string[] = [];
const spanCount = 10_000;
const batchSize = 250;
const totalRuntimeBudgetMs = 60_000;
const signalQueryBudgetMs = 10_000;
const rssGrowthBudgetBytes = 384 * 1024 * 1024;

const sources = [
  {
    platform: "claude_code",
    captureMode: "transcript",
    boundary: "session",
    skillName: "claude-diagnose",
  },
  {
    platform: "codex",
    captureMode: "rollout",
    boundary: "actionable_turn",
    skillName: "codex-diagnose",
  },
  {
    platform: "opencode",
    captureMode: "session",
    boundary: "session",
    skillName: "opencode-diagnose",
  },
  {
    platform: "pi",
    captureMode: "session",
    boundary: "session",
    skillName: "pi-diagnose",
  },
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const hexadecimalId = (value: number, length: number) => value.toString(16).padStart(length, "0");

const batchFor = (batchIndex: number) => {
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, spanCount);
  const spanIndexes = Array.from({ length: end - start }, (_, offset) => start + offset);

  return {
    schema_version: "1.0.0" as const,
    batch_id: `growth-proof-${batchIndex}`,
    source_revision: "growth-proof-r1",
    normalizer_version: "growth-proof-v1",
    spans: spanIndexes.map((index) => ({
      trace_id: hexadecimalId(index + 1, 32),
      span_id: hexadecimalId(index + 1, 16),
      name: "invoke_agent",
      started_at: "2026-07-23T10:00:00.000Z",
      ended_at: "2026-07-23T10:00:01.000Z",
      platform: sources[index % sources.length].platform,
      capture_mode: sources[index % sources.length].captureMode,
      source_authority: "source_truth" as const,
      trace_boundary: sources[index % sources.length].boundary,
      operation_name: "invoke_agent" as const,
      source_id: `growth-proof-source-${index}`,
      provider: "openai",
      model: "gpt-5",
      input_tokens: index + 1,
      output_tokens: 2,
      error_count: Math.floor(index / sources.length) % 10 === 0 ? 1 : 0,
      tool_call_count: Math.floor(index / sources.length) % 5 === 0 ? 1 : 0,
    })),
    links: spanIndexes.map((index) => ({
      link_id: hexadecimalId(10_000 + index, 32),
      span_id: hexadecimalId(index + 1, 16),
      trace_id: hexadecimalId(index + 1, 32),
      skill_invocation_id: `growth-proof-invocation-${index}`,
      skill_name: sources[index % sources.length].skillName,
    })),
  };
};

test(
  "keeps a 10,000-span big-four corpus replay-safe within time and RSS budgets",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "selftune-duckdb-growth-proof-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "observability.duckdb");
    const rssBeforeBytes = process.memoryUsage().rss;
    const peakRssBeforeBytes = process.resourceUsage().maxRSS;
    const batches = Array.from({ length: Math.ceil(spanCount / batchSize) }, (_, index) =>
      batchFor(index),
    );
    const rssAfterFixtureBytes = process.memoryUsage().rss;
    const startedAt = performance.now();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DuckDbAnalyticalStore;
        const accepted = [];
        for (const batch of batches) accepted.push(yield* store.ingest(batch));

        const queryStartedAt = performance.now();
        const signals = yield* store.querySkillSignals();
        const queryElapsedMs = performance.now() - queryStartedAt;

        const duplicates = [];
        for (const batch of batches) duplicates.push(yield* store.ingest(batch));
        const health = yield* store.health();
        return { accepted, duplicates, health, queryElapsedMs, signals };
      }).pipe(Effect.provide(makeDuckDbNodeApiAnalyticalStoreLive(databasePath)), Effect.scoped),
    );
    const totalElapsedMs = performance.now() - startedAt;
    const rssAfterRunBytes = process.memoryUsage().rss;
    const peakRssAfterBytes = process.resourceUsage().maxRSS;
    const rssGrowthBytes = Math.max(
      0,
      Math.max(rssAfterFixtureBytes, rssAfterRunBytes) - rssBeforeBytes,
      peakRssAfterBytes - peakRssBeforeBytes,
    );

    expect(result.accepted).toHaveLength(Math.ceil(spanCount / batchSize));
    expect(result.accepted.every((receipt) => receipt.disposition === "accepted")).toBe(true);
    expect(result.accepted.every((receipt) => receipt.metrics_derived === batchSize * 5)).toBe(
      true,
    );
    expect(result.duplicates).toHaveLength(Math.ceil(spanCount / batchSize));
    expect(result.duplicates.every((receipt) => receipt.disposition === "duplicate")).toBe(true);
    expect(result.health).toMatchObject({
      span_count: spanCount,
      metric_count: spanCount * 5,
      link_count: spanCount,
    });
    expect(result.signals).toHaveLength(sources.length);
    for (const [sourceIndex, source] of sources.entries()) {
      const traceCount = spanCount / sources.length;
      const inputTokens =
        traceCount * (sourceIndex + 1) + sources.length * ((traceCount * (traceCount - 1)) / 2);
      expect(result.signals).toContainEqual({
        skill_name: source.skillName,
        invocation_count: traceCount,
        trace_count: traceCount,
        error_trace_count: traceCount / 10,
        duration_ms: traceCount * 1_000,
        input_tokens: inputTokens,
        output_tokens: traceCount * 2,
        error_count: traceCount / 10,
        tool_call_count: traceCount / 5,
      });
    }

    console.info(
      `[duckdb-growth-proof] spans=${spanCount} total_ms=${totalElapsedMs.toFixed(0)} query_ms=${result.queryElapsedMs.toFixed(0)} rss_growth_mb=${(rssGrowthBytes / 1024 / 1024).toFixed(1)}`,
    );
    expect(totalElapsedMs).toBeLessThanOrEqual(totalRuntimeBudgetMs);
    expect(result.queryElapsedMs).toBeLessThanOrEqual(signalQueryBudgetMs);
    expect(rssGrowthBytes).toBeLessThanOrEqual(rssGrowthBudgetBytes);
  },
  { timeout: totalRuntimeBudgetMs + 10_000 },
);
