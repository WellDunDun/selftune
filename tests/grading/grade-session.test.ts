/**
 * Tests for cli/selftune/grading/grade-session.ts
 *
 * Covers: detectAgent, buildGradingPrompt, buildExecutionMetrics,
 *         assembleResult, findSession, latestSessionForSkill,
 *         loadExpectationsFromEvalsJson, markdown fence stripping,
 *         preamble handling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleResult,
  buildExecutionMetrics,
  buildGradingPrompt,
  buildGraduatedSummary,
  detectAgent,
  findSession,
  GRADER_SYSTEM,
  latestSessionForSkill,
  loadExpectationsFromEvalsJson,
  MAX_TRANSCRIPT_LENGTH,
  stripMarkdownFences,
} from "../../cli/selftune/grading/grade-session.js";

import type { GraderOutput, SessionTelemetryRecord } from "../../cli/selftune/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTelemetryRecord(
  overrides: Partial<SessionTelemetryRecord> = {},
): SessionTelemetryRecord {
  return {
    timestamp: "2025-01-15T10:00:00Z",
    session_id: "sess-abc",
    cwd: "/tmp/test",
    transcript_path: "/tmp/transcript.jsonl",
    tool_calls: { Read: 3, Bash: 2 },
    total_tool_calls: 5,
    bash_commands: ["ls -la", "cat foo.txt"],
    skills_triggered: ["pptx"],
    assistant_turns: 4,
    errors_encountered: 1,
    transcript_chars: 5000,
    last_user_query: "create a pptx file",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectAgent
// ---------------------------------------------------------------------------

describe("detectAgent", () => {
  it("returns null when no agent is available", () => {
    // Mock Bun.which to always return null
    const original = Bun.which;
    // @ts-expect-error -- mocking global
    Bun.which = () => null;
    try {
      expect(detectAgent()).toBeNull();
    } finally {
      // @ts-expect-error -- restoring
      Bun.which = original;
    }
  });

  it("returns first available agent", () => {
    const original = Bun.which;
    // @ts-expect-error -- mocking global
    Bun.which = (name: string) => (name === "codex" ? "/usr/bin/codex" : null);
    try {
      expect(detectAgent()).toBe("codex");
    } finally {
      // @ts-expect-error -- restoring
      Bun.which = original;
    }
  });
});

// ---------------------------------------------------------------------------
// buildGradingPrompt
// ---------------------------------------------------------------------------

describe("buildGradingPrompt", () => {
  it("includes all sections", () => {
    const telemetry = makeTelemetryRecord();
    const prompt = buildGradingPrompt(
      ["SKILL.md was read", "Output is a .pptx"],
      telemetry,
      "[USER] create a pptx\n[TOOL:Read] SKILL.md",
      "pptx",
    );

    expect(prompt).toContain("Skill: pptx");
    expect(prompt).toContain("=== PROCESS TELEMETRY ===");
    expect(prompt).toContain("=== TRANSCRIPT EXCERPT ===");
    expect(prompt).toContain("=== EXPECTATIONS ===");
    expect(prompt).toContain("1. SKILL.md was read");
    expect(prompt).toContain("2. Output is a .pptx");
    expect(prompt).toContain("[USER] create a pptx");
    expect(prompt).toContain("Skills triggered:");
    expect(prompt).toContain("pptx");
    expect(prompt).toContain("Bash commands:");
    expect(prompt).toContain("$ ls -la");
  });

  it("handles empty telemetry gracefully", () => {
    const prompt = buildGradingPrompt(
      ["Some expectation"],
      {} as SessionTelemetryRecord,
      "(no transcript)",
      "testskill",
    );

    expect(prompt).toContain("Skill: testskill");
    expect(prompt).toContain("1. Some expectation");
    expect(prompt).toContain("(none)");
  });

  it("truncates very long transcripts at MAX_TRANSCRIPT_LENGTH chars", () => {
    const longTranscript = "x".repeat(60000);
    const prompt = buildGradingPrompt(["test"], makeTelemetryRecord(), longTranscript, "pptx");
    // The transcript section should be truncated; overall prompt should be well under 60000
    expect(prompt.length).toBeLessThan(55000);
    // Verify the constant itself is 50000
    expect(MAX_TRANSCRIPT_LENGTH).toBe(50000);
  });

  it("does not truncate transcripts at or below MAX_TRANSCRIPT_LENGTH", () => {
    const exactTranscript = "y".repeat(50000);
    const prompt = buildGradingPrompt(["test"], makeTelemetryRecord(), exactTranscript, "pptx");
    // Should contain the full transcript (all 50000 y chars)
    expect(prompt).toContain(exactTranscript);
  });
});

// ---------------------------------------------------------------------------
// buildExecutionMetrics
// ---------------------------------------------------------------------------

describe("buildExecutionMetrics", () => {
  it("extracts correct fields from telemetry", () => {
    const telemetry = makeTelemetryRecord();
    const metrics = buildExecutionMetrics(telemetry);

    expect(metrics.tool_calls).toEqual({ Read: 3, Bash: 2 });
    expect(metrics.total_tool_calls).toBe(5);
    expect(metrics.total_steps).toBe(4);
    expect(metrics.bash_commands_run).toBe(2);
    expect(metrics.errors_encountered).toBe(1);
    expect(metrics.skills_triggered).toEqual(["pptx"]);
    expect(metrics.transcript_chars).toBe(5000);
  });

  it("handles missing fields with defaults", () => {
    const metrics = buildExecutionMetrics({} as SessionTelemetryRecord);

    expect(metrics.tool_calls).toEqual({});
    expect(metrics.total_tool_calls).toBe(0);
    expect(metrics.total_steps).toBe(0);
    expect(metrics.bash_commands_run).toBe(0);
    expect(metrics.errors_encountered).toBe(0);
    expect(metrics.skills_triggered).toEqual([]);
    expect(metrics.transcript_chars).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// assembleResult
// ---------------------------------------------------------------------------

describe("assembleResult", () => {
  it("produces correct GradingResult schema", () => {
    const graderOutput = {
      expectations: [
        { text: "SKILL.md was read", passed: true, evidence: "Read tool used on SKILL.md" },
      ],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1.0 },
      claims: [
        {
          claim: "File was created",
          type: "factual" as const,
          verified: true,
          evidence: "seen in bash",
        },
      ],
      eval_feedback: {
        suggestions: [],
        overall: "Good session",
      },
    };

    const telemetry = makeTelemetryRecord();
    const result = assembleResult(
      graderOutput,
      telemetry,
      "sess-abc",
      "pptx",
      "/tmp/transcript.jsonl",
    );

    expect(result.session_id).toBe("sess-abc");
    expect(result.skill_name).toBe("pptx");
    expect(result.transcript_path).toBe("/tmp/transcript.jsonl");
    expect(result.graded_at).toBeTruthy();
    expect(result.expectations).toHaveLength(1);
    expect(result.expectations[0].passed).toBe(true);
    expect(result.summary.passed).toBe(1);
    expect(result.execution_metrics.total_tool_calls).toBe(5);
    expect(result.claims).toHaveLength(1);
    expect(result.eval_feedback.overall).toBe("Good session");
  });

  it("handles null graderOutput fields gracefully", () => {
    const result = assembleResult(
      {} as unknown as GraderOutput, // missing expectations, summary, claims, eval_feedback
      makeTelemetryRecord(),
      "sess-1",
      "pptx",
      "/tmp/t.jsonl",
    );
    expect(result.expectations).toEqual([]);
    expect(result.summary.passed).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.pass_rate).toBe(0);
    expect(result.claims).toEqual([]);
    expect(result.eval_feedback.suggestions).toEqual([]);
    expect(result.eval_feedback.overall).toBe("");
  });

  it("handles null telemetry gracefully", () => {
    const graderOutput = {
      expectations: [{ text: "test", passed: true, evidence: "found" }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1.0 },
      claims: [],
      eval_feedback: { suggestions: [], overall: "ok" },
    };
    const result = assembleResult(
      graderOutput,
      null as unknown as SessionTelemetryRecord,
      "sess-1",
      "pptx",
      "/tmp/t.jsonl",
    );
    expect(result.execution_metrics.total_tool_calls).toBe(0);
    expect(result.execution_metrics.bash_commands_run).toBe(0);
    expect(result.execution_metrics.skills_triggered).toEqual([]);
  });

  it("defaults sessionId to 'unknown' when null", () => {
    const graderOutput = {
      expectations: [],
      summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      claims: [],
      eval_feedback: { suggestions: [], overall: "" },
    };
    const result = assembleResult(
      graderOutput,
      makeTelemetryRecord(),
      null as unknown as string,
      "pptx",
      "/tmp/t.jsonl",
    );
    expect(result.session_id).toBe("unknown");
  });

  it("defaults skillName to 'unknown' when null", () => {
    const graderOutput = {
      expectations: [],
      summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      claims: [],
      eval_feedback: { suggestions: [], overall: "" },
    };
    const result = assembleResult(
      graderOutput,
      makeTelemetryRecord(),
      "sess-1",
      null as unknown as string,
      "/tmp/t.jsonl",
    );
    expect(result.skill_name).toBe("unknown");
  });

  it("defaults transcriptPath to empty string when null", () => {
    const graderOutput = {
      expectations: [],
      summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      claims: [],
      eval_feedback: { suggestions: [], overall: "" },
    };
    const result = assembleResult(
      graderOutput,
      makeTelemetryRecord(),
      "sess-1",
      "pptx",
      null as unknown as string,
    );
    expect(result.transcript_path).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findSession
// ---------------------------------------------------------------------------

describe("findSession", () => {
  const records = [
    makeTelemetryRecord({ session_id: "sess-1", timestamp: "2025-01-01T00:00:00Z" }),
    makeTelemetryRecord({ session_id: "sess-2", timestamp: "2025-01-02T00:00:00Z" }),
    makeTelemetryRecord({ session_id: "sess-3", timestamp: "2025-01-03T00:00:00Z" }),
  ];

  it("returns the correct session by ID", () => {
    const found = findSession(records, "sess-2");
    expect(found).not.toBeNull();
    expect(found?.session_id).toBe("sess-2");
  });

  it("returns null when session not found", () => {
    expect(findSession(records, "nonexistent")).toBeNull();
  });

  it("returns the last matching record when duplicates exist", () => {
    const duped = [
      ...records,
      makeTelemetryRecord({ session_id: "sess-2", timestamp: "2025-02-01T00:00:00Z" }),
    ];
    const found = findSession(duped, "sess-2");
    expect(found?.timestamp).toBe("2025-02-01T00:00:00Z");
  });

  it("handles empty records array", () => {
    expect(findSession([], "any-id")).toBeNull();
  });

  it("handles records with undefined session_id", () => {
    const badRecords = [makeTelemetryRecord({ session_id: undefined as unknown as string })];
    expect(findSession(badRecords, "sess-abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// latestSessionForSkill
// ---------------------------------------------------------------------------

describe("latestSessionForSkill", () => {
  const records = [
    makeTelemetryRecord({
      session_id: "sess-1",
      skills_triggered: ["pptx"],
      timestamp: "2025-01-01T00:00:00Z",
    }),
    makeTelemetryRecord({
      session_id: "sess-2",
      skills_triggered: ["csv"],
      timestamp: "2025-01-02T00:00:00Z",
    }),
    makeTelemetryRecord({
      session_id: "sess-3",
      skills_triggered: ["pptx", "pdf"],
      timestamp: "2025-01-03T00:00:00Z",
    }),
  ];

  it("returns the most recent session matching the skill", () => {
    const found = latestSessionForSkill(records, "pptx");
    expect(found).not.toBeNull();
    expect(found?.session_id).toBe("sess-3");
  });

  it("returns null when no sessions match", () => {
    expect(latestSessionForSkill(records, "nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadExpectationsFromEvalsJson
// ---------------------------------------------------------------------------

describe("loadExpectationsFromEvalsJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "grade-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads correct expectations for a given eval ID", () => {
    const evalsData = {
      evals: [
        { id: 1, expectations: ["SKILL.md was read", "Output is .pptx"] },
        { id: 2, expectations: ["CSV was generated"] },
      ],
    };
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify(evalsData));

    const result = loadExpectationsFromEvalsJson(evalsPath, 1);
    expect(result).toEqual(["SKILL.md was read", "Output is .pptx"]);
  });

  it("returns second eval correctly", () => {
    const evalsData = {
      evals: [
        { id: 1, expectations: ["First"] },
        { id: 2, expectations: ["Second"] },
      ],
    };
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify(evalsData));

    const result = loadExpectationsFromEvalsJson(evalsPath, 2);
    expect(result).toEqual(["Second"]);
  });

  it("throws when eval ID is not found", () => {
    const evalsData = { evals: [{ id: 1, expectations: ["A"] }] };
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify(evalsData));

    expect(() => loadExpectationsFromEvalsJson(evalsPath, 99)).toThrow("Eval ID 99 not found");
  });

  it("throws when top-level data is not an object", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify([1, 2, 3]));

    expect(() => loadExpectationsFromEvalsJson(evalsPath, 1)).toThrow(
      "expected a top-level object, got array",
    );
  });

  it("throws when top-level data is a primitive", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify("just a string"));

    expect(() => loadExpectationsFromEvalsJson(evalsPath, 1)).toThrow(
      "expected a top-level object, got string",
    );
  });

  it("throws when evals property is not an array", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify({ evals: "not-an-array" }));

    expect(() => loadExpectationsFromEvalsJson(evalsPath, 1)).toThrow(
      'expected "evals" to be an array',
    );
  });

  it("throws when an eval entry is not an object", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify({ evals: ["not-an-object"] }));

    expect(() => loadExpectationsFromEvalsJson(evalsPath, 1)).toThrow(
      "expected an object, got string",
    );
  });

  it("throws when expectations is not an array", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify({ evals: [{ id: 1, expectations: "wrong" }] }));

    expect(() => loadExpectationsFromEvalsJson(evalsPath, 1)).toThrow(
      'expected "expectations" to be an array',
    );
  });

  it("throws when an expectation element is not a string", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify({ evals: [{ id: 1, expectations: [42] }] }));

    expect(() => loadExpectationsFromEvalsJson(evalsPath, 1)).toThrow(
      "expectations[0] must be a string",
    );
  });

  it("returns empty array when expectations is null", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify({ evals: [{ id: 1, expectations: null }] }));

    expect(loadExpectationsFromEvalsJson(evalsPath, 1)).toEqual([]);
  });

  it("returns empty array when expectations is undefined", () => {
    const evalsPath = join(tmpDir, "evals.json");
    writeFileSync(evalsPath, JSON.stringify({ evals: [{ id: 1 }] }));

    expect(loadExpectationsFromEvalsJson(evalsPath, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stripMarkdownFences
// ---------------------------------------------------------------------------

describe("stripMarkdownFences", () => {
  it("strips ```json ... ``` fences", () => {
    const input = '```json\n{"passed": true}\n```';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"passed": true}');
  });

  it("strips plain ``` fences", () => {
    const input = '```\n{"passed": true}\n```';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"passed": true}');
  });

  it("handles preamble text before JSON", () => {
    const input = 'Here is the result:\n{"passed": true}';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"passed": true}');
  });

  it("returns clean JSON unchanged", () => {
    const input = '{"passed": true}';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"passed": true}');
  });

  it("strips fences with preamble", () => {
    const input = 'Some text\n```json\n{"a": 1}\n```';
    const result = stripMarkdownFences(input);
    expect(result).toBe('{"a": 1}');
  });

  it("handles nested fences (triple inside triple)", () => {
    const input = '````json\n```json\n{"nested": true}\n```\n````';
    const result = stripMarkdownFences(input);
    // After stripping outermost fences, the inner content should be parseable
    expect(JSON.parse(result)).toEqual({ nested: true });
  });

  it("handles incomplete/unclosed fences", () => {
    const input = '```json\n{"passed": true}'; // no closing fence
    const result = stripMarkdownFences(input);
    expect(JSON.parse(result)).toEqual({ passed: true });
  });

  it("handles empty input", () => {
    expect(stripMarkdownFences("")).toBe("");
  });

  it("handles whitespace-only input", () => {
    expect(stripMarkdownFences("   \n  \n  ")).toBe("");
  });

  it("handles multiple fence blocks (takes first)", () => {
    const input = '```json\n{"first": true}\n```\n\n```json\n{"second": true}\n```';
    const result = stripMarkdownFences(input);
    expect(JSON.parse(result)).toEqual({ first: true });
  });
});

// ---------------------------------------------------------------------------
// GRADER_SYSTEM constant
// ---------------------------------------------------------------------------

describe("GRADER_SYSTEM", () => {
  it("contains required grading instructions", () => {
    expect(GRADER_SYSTEM).toContain("expectations");
    expect(GRADER_SYSTEM).toContain("JSON");
    expect(GRADER_SYSTEM).toContain("evidence");
    expect(GRADER_SYSTEM).toContain("PASS");
    expect(GRADER_SYSTEM).toContain("FAIL");
  });
});

// ---------------------------------------------------------------------------
// buildGraduatedSummary
// ---------------------------------------------------------------------------

describe("buildGraduatedSummary", () => {
  it("computes mean from explicit scores", () => {
    const expectations = [
      { text: "a", passed: true, evidence: "ok", score: 0.8 },
      { text: "b", passed: true, evidence: "ok", score: 0.6 },
      { text: "c", passed: false, evidence: "no", score: 0.2 },
    ];
    const result = buildGraduatedSummary(expectations);
    expect(result.mean_score).toBe(0.533);
  });

  it("defaults score to 1.0 for passed, 0.0 for failed", () => {
    const expectations = [
      { text: "a", passed: true, evidence: "ok" },
      { text: "b", passed: false, evidence: "no" },
    ];
    const result = buildGraduatedSummary(expectations);
    expect(result.mean_score).toBe(0.5);
  });

  it("computes standard deviation correctly", () => {
    const expectations = [
      { text: "a", passed: true, evidence: "ok", score: 1.0 },
      { text: "b", passed: true, evidence: "ok", score: 1.0 },
      { text: "c", passed: true, evidence: "ok", score: 1.0 },
    ];
    const result = buildGraduatedSummary(expectations);
    expect(result.score_std_dev).toBe(0);
  });

  it("empty expectations returns zeros", () => {
    const result = buildGraduatedSummary([]);
    expect(result.mean_score).toBe(0);
    expect(result.score_std_dev).toBe(0);
  });

  it("single expectation has zero std_dev", () => {
    const expectations = [{ text: "a", passed: true, evidence: "ok", score: 0.7 }];
    const result = buildGraduatedSummary(expectations);
    expect(result.mean_score).toBe(0.7);
    expect(result.score_std_dev).toBe(0);
  });

  it("clamps scores above 1.0 to 1.0", () => {
    const expectations = [{ text: "a", passed: true, evidence: "ok", score: 1.5 }];
    const result = buildGraduatedSummary(expectations);
    expect(result.mean_score).toBe(1.0);
  });

  it("clamps scores below 0.0 to 0.0", () => {
    const expectations = [{ text: "a", passed: false, evidence: "no", score: -0.25 }];
    const result = buildGraduatedSummary(expectations);
    expect(result.mean_score).toBe(0);
  });

  it("falls back to passed-based score for NaN", () => {
    const expectations = [
      { text: "a", passed: true, evidence: "ok", score: NaN },
      { text: "b", passed: false, evidence: "no", score: NaN },
    ];
    const result = buildGraduatedSummary(expectations);
    // NaN → fallback: passed=true→1.0, passed=false→0.0, mean=0.5
    expect(result.mean_score).toBe(0.5);
  });

  it("falls back to passed-based score for Infinity", () => {
    const expectations = [
      { text: "a", passed: true, evidence: "ok", score: Infinity },
      { text: "b", passed: false, evidence: "no", score: -Infinity },
    ];
    const result = buildGraduatedSummary(expectations);
    // Infinity → fallback: passed=true→1.0, -Infinity → fallback: passed=false→0.0, mean=0.5
    expect(result.mean_score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// GRADER_SYSTEM prompt updates
// ---------------------------------------------------------------------------

describe("GRADER_SYSTEM prompt updates", () => {
  it("includes score field in JSON schema", () => {
    expect(GRADER_SYSTEM).toContain("score");
    expect(GRADER_SYSTEM).toContain("0.0-1.0");
  });

  it("includes mean_score in summary schema", () => {
    expect(GRADER_SYSTEM).toContain("mean_score");
  });

  it("includes score guide", () => {
    expect(GRADER_SYSTEM).toContain("Score guide");
  });
});

// ---------------------------------------------------------------------------
// failure feedback in GRADER_SYSTEM
// ---------------------------------------------------------------------------

describe("failure feedback in GRADER_SYSTEM", () => {
  it("GRADER_SYSTEM contains failure_feedback in schema", () => {
    expect(GRADER_SYSTEM).toContain("failure_feedback");
  });

  it("GRADER_SYSTEM contains improvement_hint instruction", () => {
    expect(GRADER_SYSTEM).toContain("improvement_hint");
  });
});

// ---------------------------------------------------------------------------
// assembleResult with failure_feedback
// ---------------------------------------------------------------------------

describe("assembleResult with failure_feedback", () => {
  it("passes through failure_feedback from grader output", () => {
    const graderOutput = {
      expectations: [{ text: "test", passed: false, evidence: "not found" }],
      summary: { passed: 0, failed: 1, total: 1, pass_rate: 0 },
      claims: [],
      eval_feedback: { suggestions: [], overall: "" },
      failure_feedback: [
        {
          query: "make slides",
          failure_reason: "Skill not triggered",
          improvement_hint: "Add slide keywords",
        },
      ],
    };
    const result = assembleResult(
      graderOutput,
      makeTelemetryRecord(),
      "sess-1",
      "pptx",
      "/tmp/t.jsonl",
    );
    expect(result.failure_feedback).toBeDefined();
    expect(result.failure_feedback?.length).toBe(1);
    expect(result.failure_feedback?.[0].query).toBe("make slides");
  });

  it("failure_feedback is undefined when not in grader output", () => {
    const graderOutput = {
      expectations: [],
      summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      claims: [],
      eval_feedback: { suggestions: [], overall: "" },
    };
    const result = assembleResult(
      graderOutput,
      makeTelemetryRecord(),
      "sess-1",
      "pptx",
      "/tmp/t.jsonl",
    );
    expect(result.failure_feedback).toBeUndefined();
  });
});
