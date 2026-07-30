import { describe, expect, it } from "vitest";

import {
  buildEvaluationSubmission,
  parseEvaluationSubmission,
  type EvaluationSubmissionV1,
  type RunPackageV1,
} from "./portable";

function submission(): EvaluationSubmissionV1 {
  return {
    schema_version: 1,
    submission_id: "submission-1",
    idempotency_key: "submission-1:revision-2",
    baseline: {
      cloud_source_id: "source-1",
      cloud_snapshot_id: "snapshot-1",
      skill_id: "skill-1",
      skill_name: "Research",
      skill_revision: "revision-1",
    },
    hypothesis: {
      pattern_id: "pattern-1",
      kind: "repeated_correlated_errors",
      summary: "Repeated misses point to a routing gap.",
    },
    candidate: {
      proposal_id: "proposal-1",
      mutation_surface: "body",
      target_revision: "revision-1",
      proposed_body: "Route comparative research requests through the source checklist.",
      rationale: "The calibration cohort repeatedly missed the source-selection step.",
    },
    evaluation: {
      cloud_eval_suite_id: "suite-reviewed-1",
      manifest_digest: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      lane: "outcome_task",
      max_repetitions: 3,
      verification_only: false,
    },
    evidence: {
      cohort_fingerprint: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      selected_trace_count: 8,
      entries: [
        {
          role: "calibration",
          query: "Compare these primary sources.",
          should_trigger: true,
          source_reference: "trace:calibration-1",
        },
        {
          role: "holdout",
          query: "Find supporting evidence from primary material.",
          should_trigger: true,
          source_reference: "trace:holdout-7",
        },
      ],
    },
  };
}

describe("evaluation submission", () => {
  it("builds a bounded portable submission and round-trips through the strict parser", () => {
    const built = buildEvaluationSubmission(submission());

    expect(parseEvaluationSubmission(JSON.parse(JSON.stringify(built)))).toEqual(built);
    expect(built.evidence.entries.map((entry) => entry.role)).toEqual(["calibration", "holdout"]);
  });

  it("rejects oversized user-derived text", () => {
    const value = submission();
    const oversized = {
      ...value,
      candidate: { ...value.candidate, proposed_body: "x".repeat(16_001) },
    };

    expect(() => parseEvaluationSubmission(oversized)).toThrow("proposed_body");
  });

  it("requires both calibration and holdout trace evidence roles", () => {
    const value = submission();
    const withoutHoldout = {
      ...value,
      evidence: { ...value.evidence, entries: [value.evidence.entries[0]] },
    };

    expect(() => parseEvaluationSubmission(withoutHoldout)).toThrow("holdout");
  });

  it("rejects more than fourteen trace evidence entries", () => {
    const value = submission();
    const tooManyCases = {
      ...value,
      evidence: {
        ...value.evidence,
        entries: Array.from({ length: 15 }, (_, index) => ({
          ...value.evidence.entries[index % value.evidence.entries.length],
          source_reference: `trace:${index}`,
        })),
      },
    };

    expect(() => parseEvaluationSubmission(tooManyCases)).toThrow("1 to 14");
  });

  it("rejects an invalid cohort fingerprint", () => {
    const value = submission();
    const invalid = {
      ...value,
      evidence: {
        ...value.evidence,
        cohort_fingerprint: "sha256:not-a-fingerprint",
      },
    };

    expect(() => parseEvaluationSubmission(invalid)).toThrow("cohort_fingerprint");
  });

  it("rejects unsafe parser input while the explicit builder redacts it", () => {
    const value = submission();
    const unsafe = {
      ...value,
      candidate: {
        ...value.candidate,
        rationale: "token=secret-value came from /Users/alice/private-notes.txt",
      },
    };

    expect(() => parseEvaluationSubmission(unsafe)).toThrow("secret or absolute local path");
    const built = buildEvaluationSubmission(unsafe);
    expect(built.candidate.rationale).toContain("[redacted]");
    expect(built.candidate.rationale).toContain("[local-path]");
  });

  it("keeps a frozen Cloud suite as the evaluation authority", () => {
    const built = buildEvaluationSubmission(submission());

    expect(built.evaluation.cloud_eval_suite_id).toBe("suite-reviewed-1");
    expect("cases" in built.evaluation).toBe(false);
    expect(built.evidence.entries[1].role).toBe("holdout");
  });

  it("enforces lane and mutation semantics", () => {
    const value = submission();
    const bodyInRoutingLane = {
      ...value,
      evaluation: { ...value.evaluation, lane: "trigger_routing" },
    };
    const routingInOutcomeLane = {
      ...value,
      candidate: { ...value.candidate, mutation_surface: "routing" },
    };
    const nonVerifyingStructure = {
      ...value,
      candidate: { ...value.candidate, mutation_surface: "structure" },
      evaluation: {
        ...value.evaluation,
        lane: "structural_validation",
        verification_only: false,
      },
    };

    expect(() => parseEvaluationSubmission(bodyInRoutingLane)).toThrow("body candidates");
    expect(() => parseEvaluationSubmission(routingInOutcomeLane)).toThrow("routing candidates");
    expect(() => parseEvaluationSubmission(nonVerifyingStructure)).toThrow("verification-only");
  });

  it("is a separate contract from RunPackageV1", () => {
    const portable = buildEvaluationSubmission(submission());
    const runPackage: RunPackageV1 = {
      schema_version: 1,
      run_id: "run-1",
      producer: "cloud_improve",
      intent: { title: "Improve Research", summary: "Review a candidate." },
      evidence: [],
      candidate: { summary: "Candidate", diff_text: null },
      decision: { state: "approved", summary: "Approved" },
      validation: { state: "passed", summary: "Passed" },
      outcome: { state: "pending", summary: "Pending" },
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z",
    };

    expect(() => parseEvaluationSubmission(runPackage)).toThrow("unsupported field: run_id");
    expect("run_id" in portable).toBe(false);
    expect("submission_id" in runPackage).toBe(false);
  });
});
