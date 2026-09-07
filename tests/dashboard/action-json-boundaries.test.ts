import { describe, expect, test } from "bun:test";
import { extractDashboardActionSummary } from "../../packages/runtime/dashboard-action-result.js";
import { extractJsonObject } from "../../packages/runtime/utils/json-output.js";
import {
  readNumber,
  readObject,
  readPackageEvidenceSummary,
  readRuntimeReplayAggregateMetrics,
} from "../../packages/runtime/dashboard-action-result/package-readers.js";

describe("action JSON boundaries", () => {
  test("accepts a complete JSON object and preserves nested JSON values", () => {
    const contents = { count: 0, enabled: false, evidence: [{ query: "campaign", details: null }] };
    expect(extractJsonObject(`\n${JSON.stringify(contents)}\n`)).toEqual(contents);
  });

  test.each([
    { text: "null" },
    { text: "[]" },
    { text: "true" },
    { text: "{" },
    { text: 'log line\n{"ok":true}' },
  ])("rejects non-object or incomplete stdout: $text", ({ text }) => {
    expect(extractJsonObject(text)).toBeNull();
  });

  test("rejects arrays where a named JSON object is expected", () => {
    expect(readObject([])).toBeNull();
    expect(readObject(["passed"])).toBeNull();
    expect(readObject({ count: 0 })).toEqual({ count: 0 });
  });

  test("does not coerce truthy strings or numeric strings into measurements", () => {
    const summary = extractDashboardActionSummary(
      "replay-dry-run",
      JSON.stringify({
        improved: "true",
        deployed: "false",
        before_pass_rate: "0.5",
        after_pass_rate: 0,
      }),
    );
    expect(summary?.improved).toBeNull();
    expect(summary?.deployed).toBeNull();
    expect(summary?.before_pass_rate).toBeNull();
    expect(summary?.after_pass_rate).toBe(0);
    expect(readNumber(Infinity)).toBeNull();
    expect(readNumber(NaN)).toBeNull();
  });

  test("keeps valid neighboring evidence while discarding malformed samples", () => {
    const summary = readPackageEvidenceSummary({
      replay_failure_samples: [
        null,
        [],
        { query: "" },
        { query: "campaign", evidence: "missing output" },
      ],
      baseline_wins: 0,
    });
    expect(summary?.replay_failure_samples).toEqual([
      { query: "campaign", evidence: "missing output" },
    ]);
    expect(summary?.replay_failures).toBe(1);
    expect(summary?.baseline_wins).toBe(0);
  });

  test("leaves absent and malformed optional runtime measurements unknown", () => {
    const metrics = readRuntimeReplayAggregateMetrics({
      eval_runs: 1,
      usage_observations: 0,
      total_duration_ms: 0,
      avg_duration_ms: 0,
      total_input_tokens: "12",
      total_output_tokens: 0,
    });
    expect(metrics?.total_input_tokens).toBeNull();
    expect(metrics?.total_cost_usd).toBeNull();
    expect(metrics?.total_output_tokens).toBe(0);
  });

  test.each([{ decision: "root" }, { decision: "accepted" }, { decision: "rejected" }])(
    "recognizes candidate decision $decision",
    ({ decision }) => {
      const summary = extractDashboardActionSummary(
        "report-package",
        JSON.stringify({
          summary: {
            candidate_acceptance: { decision, rationale: "measured comparison" },
            candidate_generation: 0,
          },
        }),
      );
      expect(summary?.package_candidate_acceptance_decision).toBe(decision);
      expect(summary?.package_candidate_generation).toBe(0);
    },
  );

  test("does not present an unknown candidate decision as an accepted domain value", () => {
    const summary = extractDashboardActionSummary(
      "report-package",
      JSON.stringify({
        summary: {
          candidate_acceptance: { decision: "approved", rationale: "unrecognized decision" },
          evaluation_passed: false,
        },
      }),
    );
    expect(summary?.package_candidate_acceptance_decision).toBeUndefined();
    expect(summary?.improved).toBe(false);
  });
});
