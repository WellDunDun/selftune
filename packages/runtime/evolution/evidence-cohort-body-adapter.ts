/**
 * Adapts a bounded Evidence Cohort into the existing SKILL.md body-evolution
 * lifecycle. It deliberately owns neither cohort selection nor deployment.
 */

import { createHash } from "node:crypto";

import { Schema } from "effect";
import { EvidenceCohort, type EvidenceCohortEntry } from "@selftune/observability/evidence-cohort";

import { type EvolveBodyDeps, type EvolveBodyResult, evolveBody } from "./evolve-body.js";
import type { BodyEvolutionProposal, EvalEntry, FailurePattern } from "../types.js";
import { computeSkillVersionHash } from "../utils/skill-discovery.js";

const CohortOutcome = Schema.Union([
  Schema.Literal("failed"),
  Schema.Literal("successful"),
  Schema.Literal("counterexample"),
]);

export class EvidenceCohortReference extends Schema.Class<EvidenceCohortReference>(
  "EvidenceCohortReference",
)({
  reference: Schema.String,
  query: Schema.String,
  should_trigger: Schema.Boolean,
  outcome: CohortOutcome,
  excerpt: Schema.String,
}) {}

/**
 * A deliberately structural contract. The cohort producer may own a richer
 * schema; this is the small, versioned projection consumed by evolution.
 */
export class ResolvedEvidenceReference extends Schema.Class<ResolvedEvidenceReference>(
  "ResolvedEvidenceReference",
)({
  source_id: Schema.String,
  source_revision: Schema.String,
  trace_id: Schema.String,
  span_id: Schema.String,
  skill_invocation_id: Schema.String,
  skill_revision: Schema.String,
  query: Schema.String,
  should_trigger: Schema.Boolean,
}) {}

/** Model boundary: teacher responses are decoded before becoming a proposal. */
export class CohortBodyTeacherOutput extends Schema.Class<CohortBodyTeacherOutput>(
  "CohortBodyTeacherOutput",
)({
  schema_version: Schema.Literal(1),
  proposed_body: Schema.String,
  rationale: Schema.String,
  confidence: Schema.Number,
  target_section: Schema.String,
  scope: Schema.Literals(["section_local", "skill_specific", "task_family", "general"]),
  mutation_operation: Schema.Literals(["add", "refine", "replace", "remove"]),
  principle: Schema.String,
  applicability: Schema.String,
  failure_mode: Schema.String,
  preserved_constraints: Schema.Array(Schema.String),
  superseded_guidance: Schema.Array(Schema.String),
  uncertainty: Schema.Array(Schema.String),
}) {}

export const COHORT_BODY_GENERATOR_CONTRACT_VERSION = "evidence-body-proposal/v1";

export interface CohortBodyTeacherInput {
  schema_version: 1;
  cohort_id: string;
  cohort_fingerprint: string;
  skill_name: string;
  target_revision: string;
  current_body: string;
  calibration: ReadonlyArray<{
    reference: string;
    query: string;
    should_trigger: boolean;
    outcome: "failed" | "successful" | "counterexample";
    excerpt: string;
  }>;
}

export type CohortBodyTeacher = (input: CohortBodyTeacherInput) => Promise<unknown>;

export interface CohortBodyEvolutionDeps extends Pick<
  EvolveBodyDeps,
  | "validateBodyProposal"
  | "refineBodyProposal"
  | "appendAuditEntry"
  | "appendEvidenceEntry"
  | "writeFileSync"
> {
  computeRevision?: (skillPath: string) => string | undefined;
}

export interface CohortBodyEvolutionOptions {
  cohort: EvidenceCohort;
  /**
   * Source-native adapters resolve only selected records. Full transcripts
   * never cross this boundary; queries are matched back to stable references.
   */
  resolved_evidence: ReadonlyArray<ResolvedEvidenceReference>;
  teacher: CohortBodyTeacher;
  student_agent?: string;
  student_model?: string;
  max_iterations?: number;
  confidence_threshold?: number;
  /** Reject broad rewrites before they enter the lifecycle. */
  max_changed_lines?: number;
}

export interface ExistingSkillBodyMutationCandidate {
  candidate_kind: "existing_skill_body_mutation";
  proposal_id: string;
  skill_name: string;
  skill_path: string;
  target_revision: string;
  cohort_id: string;
  cohort_fingerprint: string;
  proposed_body: string;
  rationale: string;
  confidence: number;
  generator_contract_version: typeof COHORT_BODY_GENERATOR_CONTRACT_VERSION;
  target_section: string;
  scope: "section_local" | "skill_specific" | "task_family" | "general";
  mutation_operation: "add" | "refine" | "replace" | "remove";
  principle: string;
  applicability: string;
  failure_mode: string;
  preserved_constraints: ReadonlyArray<string>;
  superseded_guidance: ReadonlyArray<string>;
  uncertainty: ReadonlyArray<string>;
  changed_lines: number;
}

export interface CohortBodyEvolutionResult {
  status:
    | "review_ready"
    | "insufficient_evidence"
    | "stale_target"
    | "rejected"
    | "invalid_teacher_output";
  deployed: false;
  reason: string;
  candidate: ExistingSkillBodyMutationCandidate | null;
  lifecycle: EvolveBodyResult | null;
  heldout_references: ReadonlyArray<string>;
}

function bodyBelowTitle(content: string): string {
  const lines = content.split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("# ") && !line.startsWith("## "));
  return (titleIndex === -1 ? content : lines.slice(titleIndex + 1).join("\n")).trim();
}

function changedLineCount(before: string, after: string): number {
  const left = before.split("\n");
  const right = after.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) {
    suffix++;
  }
  return left.length - prefix - suffix + (right.length - prefix - suffix);
}

function stableProposalId(cohort: EvidenceCohort, output: CohortBodyTeacherOutput): string {
  const digest = createHash("sha256")
    .update(
      [
        cohort.fingerprint,
        cohort.target_skill.revision,
        output.target_section,
        output.scope,
        output.mutation_operation,
        output.principle,
        output.applicability,
        COHORT_BODY_GENERATOR_CONTRACT_VERSION,
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 20);
  return `evo-body-cohort-${digest}`;
}

function sourceKey(entry: EvidenceCohortEntry): string {
  return [
    entry.source.source_id,
    entry.source.source_revision,
    entry.source.trace_id,
    entry.source.span_id,
    entry.source.skill_invocation_id,
  ].join("\u0000");
}

function resolvedKey(entry: ResolvedEvidenceReference): string {
  return [
    entry.source_id,
    entry.source_revision,
    entry.trace_id,
    entry.span_id,
    entry.skill_invocation_id,
  ].join("\u0000");
}

function reference(entry: EvidenceCohortEntry): string {
  return `trace://${entry.source.source_id}/${entry.source.source_revision}/${entry.source.trace_id}/${entry.source.span_id}/${entry.source.skill_invocation_id}`;
}

function projectCalibration(
  cohort: EvidenceCohort,
  resolved: ReadonlyArray<ResolvedEvidenceReference>,
): EvidenceCohortReference[] {
  const bySource = new Map(
    resolved
      .filter((entry) => entry.skill_revision === cohort.target_skill.revision)
      .map((entry) => [resolvedKey(entry), entry]),
  );
  return cohort.entries.flatMap((entry) => {
    if (entry.role === "heldout_failure" || entry.role === "heldout_success") return [];
    const resolution = bySource.get(sourceKey(entry));
    if (resolution === undefined) return [];
    return [
      EvidenceCohortReference.make({
        reference: reference(entry),
        query: resolution.query,
        should_trigger: resolution.should_trigger,
        outcome:
          entry.role === "calibration_failure"
            ? "failed"
            : entry.role === "calibration_success"
              ? "successful"
              : "counterexample",
        excerpt: entry.redacted_excerpt ?? "",
      }),
    ];
  });
}

function calibrationPatterns(
  cohort: EvidenceCohort,
  calibration: ReadonlyArray<EvidenceCohortReference>,
): FailurePattern[] {
  const failed = calibration.filter((entry) => entry.outcome === "failed");
  if (failed.length === 0) return [];
  return [
    {
      pattern_id: cohort.pattern.pattern_id,
      skill_name: cohort.target_skill.skill_name,
      invocation_type: "implicit",
      missed_queries: failed.map((entry) => entry.query),
      frequency: failed.length,
      sample_sessions: failed.map((entry) => entry.reference),
      extracted_at: new Date(0).toISOString(),
    },
  ];
}

function calibrationEvalSet(calibration: ReadonlyArray<EvidenceCohortReference>): EvalEntry[] {
  return calibration.map((entry) => ({
    query: entry.query,
    should_trigger: entry.should_trigger,
  }));
}

/**
 * Produces a review-only, exact-revision body candidate. The existing
 * evolveBody function remains the sole proposal/validation/refinement/audit
 * lifecycle; this adapter only provides a cohort-derived input seam.
 */
export async function evolveBodyFromEvidenceCohort(
  options: CohortBodyEvolutionOptions,
  deps: CohortBodyEvolutionDeps = {},
): Promise<CohortBodyEvolutionResult> {
  const cohort = Schema.decodeUnknownSync(EvidenceCohort)(options.cohort);
  const resolvedEvidence = Schema.decodeUnknownSync(Schema.Array(ResolvedEvidenceReference))(
    options.resolved_evidence,
  );
  const calibration = projectCalibration(cohort, resolvedEvidence);
  const heldoutReferences = cohort.entries
    .filter((entry) => entry.role === "heldout_failure" || entry.role === "heldout_success")
    .map(reference);
  if (
    !calibration.some((entry) => entry.outcome === "failed") ||
    !calibration.some((entry) => entry.outcome === "successful")
  ) {
    return {
      status: "insufficient_evidence",
      deployed: false,
      candidate: null,
      lifecycle: null,
      heldout_references: heldoutReferences,
      reason:
        "Selected evidence could not be resolved at the exact target revision with both failure and success contrast.",
    };
  }
  const computeRevision = deps.computeRevision ?? computeSkillVersionHash;
  const currentRevision = computeRevision(cohort.target_skill.skill_path);
  if (currentRevision !== cohort.target_skill.revision) {
    return {
      status: "stale_target",
      deployed: false,
      candidate: null,
      lifecycle: null,
      heldout_references: heldoutReferences,
      reason: "The installed skill no longer matches the cohort target revision.",
    };
  }

  const currentContent = await Bun.file(cohort.target_skill.skill_path).text();
  const currentBody = bodyBelowTitle(currentContent);
  let candidate: ExistingSkillBodyMutationCandidate | null = null;
  let teacherError: string | null = null;
  const maxChangedLines = options.max_changed_lines ?? 40;

  const lifecycle = await evolveBody(
    {
      skillName: cohort.target_skill.skill_name,
      skillPath: cohort.target_skill.skill_path,
      target: "body",
      teacherAgent: "evidence-cohort-teacher",
      studentAgent: options.student_agent ?? "codex",
      ...(options.student_model ? { studentModel: options.student_model } : {}),
      dryRun: true,
      maxIterations: options.max_iterations ?? 1,
      confidenceThreshold: options.confidence_threshold ?? 0.6,
    },
    {
      ...deps,
      buildEvalSet: () => calibrationEvalSet(calibration),
      readEffectiveSkillUsageRecords: () => [],
      extractFailurePatterns: () => calibrationPatterns(cohort, calibration),
      generateBodyProposal: async () => {
        const raw = await options.teacher({
          schema_version: 1,
          cohort_id: cohort.fingerprint,
          cohort_fingerprint: cohort.fingerprint,
          skill_name: cohort.target_skill.skill_name,
          target_revision: cohort.target_skill.revision,
          current_body: currentBody,
          calibration,
        });
        let output: CohortBodyTeacherOutput;
        try {
          output = Schema.decodeUnknownSync(CohortBodyTeacherOutput)(raw);
        } catch (error) {
          teacherError =
            error instanceof Error ? error.message : "Teacher output did not match schema.";
          throw error;
        }
        if (output.confidence < 0 || output.confidence > 1) {
          teacherError = "Teacher confidence must be between 0 and 1.";
          throw new Error(teacherError);
        }
        if (!output.proposed_body.trim() || output.proposed_body.trim() === currentBody) {
          teacherError = "Teacher output must contain a non-empty body mutation.";
          throw new Error(teacherError);
        }
        if (
          (output.scope === "task_family" || output.scope === "general") &&
          new Set(calibration.map((entry) => new URL(entry.reference).hostname)).size < 3
        ) {
          teacherError =
            "Task-family or general guidance requires evidence spanning at least three distinct sources.";
          throw new Error(teacherError);
        }
        const changedLines = changedLineCount(currentBody, output.proposed_body.trim());
        if (changedLines > maxChangedLines) {
          teacherError = `Teacher output exceeds the ${maxChangedLines}-line minimal-mutation bound.`;
          throw new Error(teacherError);
        }
        const proposalId = stableProposalId(cohort, output);
        candidate = {
          candidate_kind: "existing_skill_body_mutation",
          proposal_id: proposalId,
          skill_name: cohort.target_skill.skill_name,
          skill_path: cohort.target_skill.skill_path,
          target_revision: cohort.target_skill.revision,
          cohort_id: cohort.fingerprint,
          cohort_fingerprint: cohort.fingerprint,
          proposed_body: output.proposed_body.trim(),
          rationale: output.rationale,
          confidence: output.confidence,
          generator_contract_version: COHORT_BODY_GENERATOR_CONTRACT_VERSION,
          target_section: output.target_section,
          scope: output.scope,
          mutation_operation: output.mutation_operation,
          principle: output.principle,
          applicability: output.applicability,
          failure_mode: output.failure_mode,
          preserved_constraints: output.preserved_constraints,
          superseded_guidance: output.superseded_guidance,
          uncertainty: output.uncertainty,
          changed_lines: changedLines,
        };
        const proposal: BodyEvolutionProposal = {
          proposal_id: proposalId,
          skill_name: cohort.target_skill.skill_name,
          skill_path: cohort.target_skill.skill_path,
          original_body: currentContent,
          proposed_body: candidate.proposed_body,
          rationale: output.rationale,
          target: "body",
          failure_patterns: calibrationPatterns(cohort, calibration).map(
            (pattern) => pattern.pattern_id,
          ),
          confidence: output.confidence,
          created_at: new Date(0).toISOString(),
          status: "pending",
        };
        return proposal;
      },
    },
  );

  if (teacherError) {
    return {
      status: "invalid_teacher_output",
      deployed: false,
      candidate: null,
      lifecycle,
      heldout_references: heldoutReferences,
      reason: teacherError,
    };
  }

  if (computeRevision(cohort.target_skill.skill_path) !== cohort.target_skill.revision) {
    return {
      status: "stale_target",
      deployed: false,
      candidate: null,
      lifecycle,
      heldout_references: heldoutReferences,
      reason: "The installed skill changed while the cohort candidate was being evaluated.",
    };
  }

  if (lifecycle.validation?.improved && candidate) {
    return {
      status: "review_ready",
      deployed: false,
      candidate,
      lifecycle,
      heldout_references: heldoutReferences,
      reason: "Review-ready existing-skill body mutation; no automatic apply was performed.",
    };
  }
  return {
    status: "rejected",
    deployed: false,
    candidate: null,
    lifecycle,
    heldout_references: heldoutReferences,
    reason: lifecycle.reason,
  };
}
