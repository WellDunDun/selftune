import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  EvalEntry,
  MonitoringSnapshot,
  RoutingReplayEntryResult,
  SkillUnitTest,
  UnitTestSuiteResult,
} from "../../packages/runtime/types/evaluation.js";

describe("evaluation contracts", () => {
  test("decodes routing entries and rejects invalid invocation modes", () => {
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(EvalEntry));
    expect(
      decode('{"query":"write a campaign","should_trigger":true,"invocation_type":"implicit"}'),
    ).toEqual({ query: "write a campaign", should_trigger: true, invocation_type: "implicit" });
    expect(() => decode('{"query":"write a campaign","should_trigger":"true"}')).toThrow();
    expect(() =>
      decode('{"query":"write a campaign","should_trigger":true,"invocation_type":"invalid"}'),
    ).toThrow();
  });

  test("checks assertions inside unit tests, not just the outer object", () => {
    const valid: SkillUnitTest = {
      id: "campaign",
      skill_name: "marketing",
      query: "write a campaign",
      assertions: [{ type: "contains", value: "campaign" }],
    };
    expect(Schema.is(SkillUnitTest)(valid)).toBe(true);
    expect(
      Schema.is(SkillUnitTest)({ ...valid, assertions: [{ type: "unknown", value: "campaign" }] }),
    ).toBe(false);
    expect(Schema.is(SkillUnitTest)({ ...valid, assertions: [null] })).toBe(false);
  });

  test("requires complete run results and validates each result", () => {
    const suite: UnitTestSuiteResult = {
      skill_name: "marketing",
      total: 1,
      passed: 1,
      failed: 0,
      pass_rate: 1,
      results: [{ test_id: "campaign", passed: true, assertion_results: [], duration_ms: 12 }],
      run_at: "2026-09-05T00:00:00Z",
    };
    expect(Schema.is(UnitTestSuiteResult)(suite)).toBe(true);
    expect(Schema.is(UnitTestSuiteResult)({ ...suite, results: undefined })).toBe(false);
    expect(Schema.is(UnitTestSuiteResult)({ ...suite, results: [{ passed: true }] })).toBe(false);
  });

  test("keeps unknown runtime measurements null and rejects numeric strings", () => {
    const result: RoutingReplayEntryResult = {
      query: "write a campaign",
      should_trigger: true,
      triggered: true,
      passed: true,
      runtime_metrics: {
        input_tokens: null,
        output_tokens: 12,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        total_cost_usd: null,
        duration_ms: 40,
        num_turns: 1,
      },
    };
    expect(Schema.is(RoutingReplayEntryResult)(result)).toBe(true);
    expect(
      Schema.is(RoutingReplayEntryResult)({
        ...result,
        runtime_metrics: { ...result.runtime_metrics, input_tokens: "12" },
      }),
    ).toBe(false);
  });

  test("requires monitoring counts for each supported invocation mode", () => {
    const snapshot: MonitoringSnapshot = {
      timestamp: "2026-09-05T00:00:00Z",
      skill_name: "marketing",
      window_sessions: 1,
      skill_checks: 1,
      pass_rate: 1,
      false_negative_rate: 0,
      regression_detected: false,
      baseline_pass_rate: 1,
      by_invocation_type: {
        explicit: { passed: 1, total: 1 },
        implicit: { passed: 0, total: 0 },
        contextual: { passed: 0, total: 0 },
        negative: { passed: 0, total: 0 },
      },
    };
    expect(Schema.is(MonitoringSnapshot)(snapshot)).toBe(true);
    expect(Schema.is(MonitoringSnapshot)({ ...snapshot, by_invocation_type: {} })).toBe(false);
  });
});
