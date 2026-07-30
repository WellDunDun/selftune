import { describe, expect, test } from "bun:test";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import {
  ImproveEvaluationProjectionFailure,
  projectImproveEvaluationSubmission,
} from "../../packages/runtime/evolution/improve-evaluation-projector.js";
import type { ExistingSkillBodyMutationCandidate } from "../../packages/runtime/evolution/evidence-cohort-body-adapter.js";
import {
  type EvidenceCohort,
  materializeEvidenceCohort,
} from "@selftune/observability/evidence-cohort";

const revision = "sha256:installed-skill-revision";

const sourceCandidate = (index: number, error_count: number) => ({
  trace_id: index.toString(16).padStart(32, "0"),
  span_id: (index + 100).toString(16).padStart(16, "0"),
  skill_invocation_id: `invocation-${index}`,
  source_id: "claude-code-rollout",
  source_revision: `rollout-${index}`,
  duration_ms: 100,
  input_tokens: 10,
  output_tokens: 5,
  error_count,
  tool_call_count: 1,
  source_excerpt: error_count > 0 ? "already redacted failure" : "already redacted success",
});

const cohort = (): Promise<EvidenceCohort> =>
  Effect.runPromise(
    materializeEvidenceCohort({
      schema_version: "1.0.0",
      selector_version: "projector-test-v1",
      pattern: {
        pattern_id: "pattern-test-skill",
        kind: "repeated_correlated_errors",
        skill_id: "test-skill",
        skill_name: "test-skill",
      },
      target_skill: {
        skill_id: "test-skill",
        skill_name: "test-skill",
        skill_path: "/not-exported/SKILL.md",
        revision,
      },
      source_allowlist: ["claude-code-rollout"],
      excerpt_limit_bytes: 120,
      request_limit_bytes: 4_096,
      candidates: [
        sourceCandidate(1, 1),
        sourceCandidate(2, 1),
        sourceCandidate(3, 0),
        sourceCandidate(4, 0),
      ],
    }),
  );

const candidate = (): ExistingSkillBodyMutationCandidate => ({
  candidate_kind: "existing_skill_body_mutation",
  proposal_id: "proposal-test-skill",
  skill_name: "test-skill",
  skill_path: "/not-exported/SKILL.md",
  target_revision: revision,
  cohort_id: "cohort-test-skill",
  cohort_fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  proposed_body: "Use the test workflow when the task needs a test.",
  rationale: "A narrow correction for repeated execution errors.",
  confidence: 0.8,
  generator_contract_version: "evidence-body-proposal/v1",
  target_section: "Instructions",
  scope: "section_local",
  mutation_operation: "refine",
  principle: "Keep the test workflow explicit.",
  applicability: "Test tasks.",
  failure_mode: "The instruction was omitted.",
  preserved_constraints: [],
  superseded_guidance: [],
  uncertainty: [],
  changed_lines: 1,
});

const inputFor = async () => {
  const selected = await cohort();
  return {
    cohort: selected,
    candidate: candidate(),
    resolved_evidence: selected.entries.map((entry) => ({
      ...entry.source,
      skill_revision: revision,
      query: `query ${entry.source.trace_id}`,
      should_trigger: true,
      raw_transcript: "NEVER_EXPORT_THIS_RAW_TRANSCRIPT",
    })),
    cloud_source_id: "cloud-source-1",
    cloud_snapshot_id: "cloud-snapshot-1",
    cloud_skill_id: "cloud-skill-uuid-1",
    cloud_eval_suite_id: "suite-reviewed-outcome-task",
    manifest_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    lane: "outcome_task" as const,
    max_repetitions: 3,
  };
};

const failure = async (effect: ReturnType<typeof projectImproveEvaluationSubmission>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === "Success") throw new Error("Expected projection failure.");
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
  if (!(failure instanceof ImproveEvaluationProjectionFailure)) {
    throw new Error("Expected ImproveEvaluationProjectionFailure.");
  }
  return failure;
};

describe("projectImproveEvaluationSubmission", () => {
  test("projects deterministically into the portable outcome-task submission", async () => {
    const input = await inputFor();
    const first = await Effect.runPromise(projectImproveEvaluationSubmission(input));
    const second = await Effect.runPromise(projectImproveEvaluationSubmission(input));

    expect(first).toEqual(second);
    expect(first.schema_version).toBe(1);
    expect(first.baseline).toEqual({
      cloud_source_id: "cloud-source-1",
      cloud_snapshot_id: "cloud-snapshot-1",
      skill_id: "cloud-skill-uuid-1",
      skill_name: "test-skill",
      skill_revision: revision,
    });
    expect(first.evaluation).toEqual({
      cloud_eval_suite_id: "suite-reviewed-outcome-task",
      manifest_digest: input.manifest_digest,
      lane: "outcome_task",
      max_repetitions: 3,
      verification_only: false,
    });
    expect(first.evidence.entries.some((entry) => entry.role === "calibration")).toBe(true);
    expect(first.evidence.entries.some((entry) => entry.role === "holdout")).toBe(true);
  });

  test("fails closed when the candidate revision differs from the exact cohort target", async () => {
    const input = await inputFor();
    const result = await failure(
      projectImproveEvaluationSubmission({
        ...input,
        candidate: { ...input.candidate, target_revision: "different-revision" },
      }),
    );

    expect(result.reason).toBe("candidate_revision_mismatch");
  });

  test("fails closed when a heldout entry cannot resolve at the exact revision", async () => {
    const input = await inputFor();
    const heldout = input.cohort.entries.find((entry) => entry.role.startsWith("heldout"));
    if (heldout === undefined) throw new Error("Expected heldout cohort evidence.");
    const result = await failure(
      projectImproveEvaluationSubmission({
        ...input,
        resolved_evidence: input.resolved_evidence.filter(
          (entry) => entry.trace_id !== heldout.source.trace_id,
        ),
      }),
    );

    expect(result.reason).toBe("unresolved_evidence");
  });

  test("requires explicit Cloud source, snapshot, skill, suite, and manifest identities", async () => {
    const input = await inputFor();
    const result = await failure(
      projectImproveEvaluationSubmission({ ...input, cloud_snapshot_id: "" }),
    );

    expect(result.reason).toBe("missing_cloud_identity");
  });

  test("does not confuse the local skill identity with Cloud's skill UUID", async () => {
    const input = await inputFor();
    const result = await Effect.runPromise(projectImproveEvaluationSubmission(input));

    expect(input.cohort.target_skill.skill_id).toBe("test-skill");
    expect(result.baseline.skill_id).toBe("cloud-skill-uuid-1");
  });

  test("requires the stochastic minimum for an outcome-task body evaluation", async () => {
    const input = await inputFor();
    const result = await failure(
      projectImproveEvaluationSubmission({ ...input, max_repetitions: 2 }),
    );

    expect(result.reason).toBe("semantic_incompatibility");
  });

  test("uses harness-neutral trace references without leaking transcripts or local paths", async () => {
    const input = await inputFor();
    const result = await Effect.runPromise(projectImproveEvaluationSubmission(input));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("NEVER_EXPORT_THIS_RAW_TRANSCRIPT");
    expect(serialized).not.toContain("/not-exported/SKILL.md");
    expect(
      result.evidence.entries.every((entry) => entry.source_reference.startsWith("trace://")),
    ).toBe(true);
    expect(serialized).toContain("trace://claude-code-rollout/");
    expect(serialized).not.toContain("codex://");
  });

  test("rejects structural validation for a body candidate instead of making an improvement claim", async () => {
    const input = await inputFor();
    const result = await failure(
      projectImproveEvaluationSubmission({ ...input, lane: "structural_validation" }),
    );

    expect(result.reason).toBe("semantic_incompatibility");
  });
});
