import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getEvaluationSubmissionDraft, openDb } from "@selftune/local-store";
import { DuckDbAnalyticalStore } from "@selftune/observability";
import { computeSkillVersionHash } from "@selftune/runtime/utils/skill-discovery";
import { Effect, Layer } from "effect";

import {
  TraceCandidatePreparation,
  decodePreparedTraceCandidateDraft,
  executionPatternIdForSkill,
  makeTraceCandidatePreparationLayer,
} from "../src/trace-candidate-service.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);

describe("historical task-quality candidate", () => {
  test("uses three exact explicit DuckDB-linked tasks with separate blind partitions", async () => {
    const sqlite = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "selftune-historical-task-quality-"));
    directories.push(root);
    const skillDirectory = join(root, "skills", "to-issues");
    mkdirSync(skillDirectory, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    const currentBody = "Break plans into vertical issue slices.";
    writeFileSync(
      skillPath,
      `---\nname: to-issues\ndescription: Break plans into issues.\n---\n\n# To Issues\n\n${currentBody}\n`,
    );
    const revision = computeSkillVersionHash(skillPath);
    if (!revision) throw new Error("fixture revision missing");
    const tasks = [
      "create all of them as issues /to-issues",
      "break ADR 0005 into tracked GitHub issues",
      "create a go-live checklist and then create any issues /to-issues",
    ];
    for (const [index, task] of tasks.entries()) {
      const sessionId = `historical-session-${index}`;
      const invocationId = `historical-invocation-${index}`;
      sqlite.run(
        "INSERT INTO sessions (session_id, platform, capture_mode) VALUES (?, 'claude_code', 'replay')",
        [sessionId],
      );
      sqlite.run(
        `INSERT INTO skill_invocations
          (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
           triggered, query, skill_path, source, platform, capture_mode, skill_version_hash)
         VALUES (?, ?, '2026-08-06T00:00:00.000Z', 'to-issues', 'explicit',
           1, ?, ?, 'claude_code_replay', 'claude_code', 'replay', ?)`,
        [invocationId, sessionId, task, skillPath, revision],
      );
    }
    const references = tasks.map((_, index) => ({
      trace_id: (index + 1).toString(16).repeat(32),
      span_id: (index + 5).toString(16).repeat(16),
      skill_invocation_id: `historical-invocation-${index}`,
      source_id: `source-${index}`,
      source_revision: `source-revision-${index}`,
      trace_boundary: "session" as const,
      capture_mode: "replay" as const,
      source_authority: "source_truth" as const,
      evidence_quality: "source_exact" as const,
      model: "claude-opus",
    }));
    const analytical = Layer.succeed(
      DuckDbAnalyticalStore,
      DuckDbAnalyticalStore.of({
        hasExactBatchReceipt: () => Effect.succeed(false),
        ingest: () => Effect.die("unused"),
        querySkillSignals: () =>
          Effect.succeed([
            {
              skill_name: "to-issues",
              invocation_count: 3,
              trace_count: 3,
              error_trace_count: 2,
              duration_ms: 0,
              input_tokens: 0,
              output_tokens: 0,
              error_count: 62,
              tool_call_count: 3,
            },
          ]),
        queryEvidenceCohortCandidates: () => Effect.succeed([]),
        queryHistoricalSkillTaskReferences: () => Effect.succeed(references),
        queryHistoricalMetricRollups: () => Effect.die("unused"),
        health: () => Effect.die("unused"),
      }),
    );
    let teacherCalls = 0;
    const calibratedBodies: string[] = [];
    const layer = Layer.provide(
      makeTraceCandidatePreparationLayer({
        sqlite,
        searchDirs: [join(root, "skills")],
        historicalTaskCalibrator: async (input) => {
          calibratedBodies.push(input.body);
          const candidateIndex = Number(input.body.match(/candidate-(\d+)/)?.[1] ?? "0");
          return candidateIndex === 0 || candidateIndex === 3
            ? {
                passed: false,
                score: 0.2,
                output: "I need another approval round before drafting issues.",
                feedback: "missing_acceptance_criteria, missing_blocked_by_dependencies",
                process: {
                  input_tokens: 20,
                  output_tokens: 20,
                  wall_time_ms: 20,
                },
              }
            : {
                passed: true,
                score: candidateIndex === 2 ? 1 : 0.9,
                output: `Complete issue draft from candidate ${candidateIndex}.`,
                feedback: "none",
                process: {
                  input_tokens: 100,
                  output_tokens: candidateIndex === 2 ? 80 : 40,
                  wall_time_ms: candidateIndex === 2 ? 200 : 100,
                },
              };
        },
        teacher: async (input) => ({
          schema_version: 1,
          proposed_body: `${input.current_body}\n\ncandidate-${++teacherCalls}: When explicitly asked to create issues, produce complete drafts with acceptance criteria and Blocked by dependencies.`,
          rationale: "Avoids a redundant approval round trip for explicit publish requests.",
          confidence: 0.8,
          target_section: "Process",
          scope: "section_local",
          mutation_operation: "add",
          principle: "Honor explicit approval.",
          applicability: "Explicit issue creation requests.",
          failure_mode: "The workflow asks for approval that the user already supplied.",
          preserved_constraints: ["Keep external publishing review-only during evaluation."],
          superseded_guidance: [],
          uncertainty: ["Execution replay must confirm the effect."],
        }),
      }),
      analytical,
    );
    const review = await Effect.runPromise(
      Effect.gen(function* () {
        const preparation = yield* TraceCandidatePreparation;
        return yield* preparation.prepare({
          pattern_id: executionPatternIdForSkill("to-issues"),
          candidate_count: 3,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(review).toMatchObject({
      readiness: "review_ready",
      evidence: { cohort_entries: 3, resolved_entries: 3 },
      candidate: { body: expect.stringContaining("candidate-2") },
      search: {
        requested_candidates: 3,
        generated_candidates: 3,
        calibrated_candidates: 3,
        required_calibration_repetitions: 3,
        current_calibration_passed_repetitions: 0,
        selected_candidate_id: expect.any(String),
        selection_method: "pareto_calibration_frontier",
      },
    });
    expect(teacherCalls).toBe(3);
    expect(calibratedBodies).toHaveLength(10);
    expect(calibratedBodies[0]).toBe(currentBody);
    const stored = await Effect.runPromise(
      getEvaluationSubmissionDraft(sqlite, review.draft_id ?? "missing"),
    );
    const decoded = await Effect.runPromise(
      decodePreparedTraceCandidateDraft(JSON.parse(stored?.payload_json ?? "null")),
    );
    expect(decoded.schema_version).toBe(2);
    if (decoded.schema_version === 2) {
      expect(decoded.cohort.pattern.kind).toBe("historical_task_quality");
      expect(decoded.cohort.entries.map((entry) => entry.redacted_task)).not.toContain(
        expect.stringContaining("/to-issues"),
      );
      expect(decoded.cohort.entries.map((entry) => entry.role)).toEqual([
        "calibration",
        "selection",
        "audit_holdout",
      ]);
      expect(decoded.search?.requested_candidates).toBe(3);
      expect(decoded.search?.candidate_summaries).toHaveLength(3);
      expect(decoded.search?.candidate_summaries.map((entry) => entry.scored_repetitions)).toEqual([
        3, 3, 1,
      ]);
      expect(decoded.search?.frontier_candidate_ids.length).toBeGreaterThan(0);
      expect(decoded.candidate).not.toBeNull();
      if (decoded.candidate !== null) {
        expect(decoded.search?.selected_candidate_id).toBe(decoded.candidate.proposal_id);
      }
      expect(JSON.stringify(decoded)).not.toContain("error_count");
      expect(
        new TextEncoder().encode(JSON.stringify(decoded.cohort.entries)).byteLength,
      ).toBeLessThanOrEqual(8_192);
    }

    let losingTeacherCalls = 0;
    const losingLayer = Layer.provide(
      makeTraceCandidatePreparationLayer({
        sqlite,
        searchDirs: [join(root, "skills")],
        historicalTaskCalibrator: async () => ({
          passed: false,
          score: 0.2,
          output: "Still missing complete issue drafts.",
          feedback: "missing_acceptance_criteria",
          process: { input_tokens: 20, output_tokens: 20, wall_time_ms: 20 },
        }),
        teacher: async (input) => ({
          schema_version: 1,
          proposed_body: `${input.current_body}\n\nlosing-candidate-${++losingTeacherCalls}`,
          rationale: "A bounded candidate that does not fix the measured failure.",
          confidence: 0.5,
          target_section: "Process",
          scope: "section_local",
          mutation_operation: "add",
          principle: "Try a minimal instruction change.",
          applicability: "Issue drafting requests.",
          failure_mode: "The candidate does not improve the calibration task.",
          preserved_constraints: ["Keep evaluation review-only."],
          superseded_guidance: [],
          uncertainty: ["Calibration is expected to reject this candidate."],
        }),
      }),
      analytical,
    );
    const noWinner = await Effect.runPromise(
      Effect.gen(function* () {
        const preparation = yield* TraceCandidatePreparation;
        return yield* preparation.prepare({
          pattern_id: executionPatternIdForSkill("to-issues"),
          candidate_count: 2,
          calibration_repetitions: 3,
        });
      }).pipe(Effect.provide(losingLayer)),
    );
    const noWinnerDraftId = noWinner.draft_id;
    expect(noWinner).toMatchObject({
      readiness: "not_ready",
      draft_id: expect.any(String),
      candidate: null,
      search: {
        requested_candidates: 2,
        generated_candidates: 2,
        calibrated_candidates: 2,
        required_calibration_repetitions: 3,
        current_calibration_passed_repetitions: 0,
        frontier_candidate_ids: [],
        selected_candidate_id: null,
        candidate_summaries: [
          expect.objectContaining({
            calibration_passed: false,
            scored_repetitions: 1,
            passed_repetitions: 0,
            frontier_member: false,
            selected: false,
          }),
          expect.objectContaining({
            calibration_passed: false,
            scored_repetitions: 1,
            passed_repetitions: 0,
            frontier_member: false,
            selected: false,
          }),
        ],
      },
    });
    const noWinnerStored = await Effect.runPromise(
      getEvaluationSubmissionDraft(sqlite, noWinnerDraftId ?? "missing"),
    );
    const noWinnerDecoded = await Effect.runPromise(
      decodePreparedTraceCandidateDraft(JSON.parse(noWinnerStored?.payload_json ?? "null")),
    );
    expect(noWinnerDecoded.schema_version).toBe(2);
    if (noWinnerDecoded.schema_version === 2) {
      expect(noWinnerDecoded.candidate).toBeNull();
      expect(noWinnerDecoded.search?.selected_candidate_id).toBeNull();
      expect(noWinnerDecoded.search?.candidate_summaries).toHaveLength(2);
    }
    sqlite.close();
  });
});
