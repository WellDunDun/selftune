import { expect, test } from "bun:test";
import {
  assertDiagnosticExit,
  parseDoctorOutput,
  parseDryRunEvolutionOutput,
  parseGradingOutput,
} from "./output-contracts.js";

test("Docker diagnostics reject crash exits, empty output, and malformed checks", () => {
  const report = JSON.stringify({
    checks: [{ name: "logs", status: "warn", message: "No sessions yet" }],
  });
  expect(() => assertDiagnosticExit(0, report)).not.toThrow();
  expect(() => assertDiagnosticExit(1, report)).not.toThrow();
  expect(() => assertDiagnosticExit(2, report)).toThrow();
  expect(() => assertDiagnosticExit(1, " ")).toThrow();
  expect(parseDoctorOutput(report).checks[0]?.status).toBe("warn");
  for (const invalid of [
    "stack trace",
    "null",
    '{"checks":{}}',
    '{"checks":[{"status":"healthy"}]}',
  ]) {
    expect(() => parseDoctorOutput(invalid)).toThrow();
  }
});

test("dry-run evolution cannot pass with deployment or an untyped error object", () => {
  const expected = { deployed: false, reason: "dry-run", skill: "example" } as const;
  expect(
    parseDryRunEvolutionOutput('{"deployed":false,"reason":"dry-run","skill":"example"}'),
  ).toEqual(expected);
  for (const invalid of [
    '{"deployed":true,"reason":"deployed"}',
    '{"deployed":false,"reason":42}',
    '{"error":"failed"}',
    "null",
  ]) {
    expect(() => parseDryRunEvolutionOutput(invalid)).toThrow();
  }
});

test("grading smoke validates the complete persisted grading contract", () => {
  const result = {
    expectations: [{ text: "Skill used", passed: true, evidence: "read skill" }],
    summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    claims: [],
    eval_feedback: { suggestions: [], overall: "pass" },
    session_id: "session-1",
    skill_name: "example",
    transcript_path: "/fixture/transcript.jsonl",
    graded_at: "2026-09-07T00:00:00.000Z",
    execution_metrics: {
      tool_calls: {},
      total_tool_calls: 0,
      total_steps: 0,
      bash_commands_run: 0,
      errors_encountered: 0,
      skills_triggered: [],
      transcript_chars: 0,
    },
  };
  expect(parseGradingOutput(JSON.stringify(result))).toEqual(result);
  expect(() =>
    parseGradingOutput(JSON.stringify({ ...result, summary: { pass_rate: "100%" } })),
  ).toThrow();
  expect(() => parseGradingOutput('{"summary":{"pass_rate":1}}')).toThrow();
});
