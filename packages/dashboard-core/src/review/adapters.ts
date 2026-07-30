import type { RunReviewState, RunReviewView } from "./run-package";

interface LocalSourceMergeTarget {
  readonly target_path: string;
  readonly summary: string;
  readonly merged_diff: string;
  readonly conflict_files: readonly string[];
}

export interface LocalSourceMergeReviewInput {
  readonly approval_id: string;
  readonly status: string;
  readonly skill_name: string;
  readonly source: string;
  readonly harness_id: string;
  readonly model: string | null;
  readonly installed_hash: string;
  readonly latest_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly receipt: { readonly status: string; readonly receipt_id: string } | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly targets: readonly LocalSourceMergeTarget[];
}

function localState(status: string): RunReviewState {
  if (status === "approved") return "applied";
  if (status === "declined") return "declined";
  if (status === "stale") return "stale";
  if (status === "expired") return "expired";
  if (status === "failed") return "failed";
  return "pending";
}

export function adaptLocalSourceMerge(input: LocalSourceMergeReviewInput): RunReviewView {
  const state = localState(input.status);
  const diffText = input.targets
    .map((target) => target.merged_diff)
    .filter(Boolean)
    .join("\n");
  const outcomeSummary =
    state === "applied"
      ? `Applied merged source revision ${input.latest_hash}.`
      : (input.failure?.message ??
        (state === "declined"
          ? "The reviewed merge was declined; installed files were left unchanged."
          : "The staged merge has not changed installed files."));
  return {
    runId: input.approval_id,
    producer: "local_source_merge",
    intent: {
      title: `Merge ${input.skill_name} source update`,
      summary: `Review the staged merge from ${input.source} before updating the installed package.`,
    },
    evidence: [
      { label: "Connection", value: input.harness_id },
      { label: "Model", value: input.model ?? "Default model" },
      { label: "Installed revision", value: input.installed_hash },
      { label: "Source revision", value: input.latest_hash },
    ],
    candidate: {
      summary: input.targets.map((target) => target.summary).join(" "),
      diffText: diffText || null,
    },
    decision: {
      state,
      summary:
        state === "pending"
          ? `Awaiting explicit approval before ${input.expires_at}.`
          : outcomeSummary,
    },
    validation: {
      state: state === "pending" ? "pending" : state === "applied" ? "passed" : state,
      summary:
        state === "applied"
          ? "Source, installed files, and staged candidate fingerprints matched at apply time."
          : "Fingerprints will be checked again immediately before apply.",
    },
    outcome: { state, summary: outcomeSummary },
    createdAt: input.created_at,
    updatedAt: input.updated_at,
  };
}

interface CloudRunInput {
  readonly id: string;
  readonly status: string;
  readonly phase: string | null;
  readonly applyTarget: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface CloudCandidateInput {
  readonly id: string;
  readonly status: string;
  readonly mutationSurface: string | null;
  readonly diffText: string | null;
  readonly currentSkillScore: number | null;
  readonly candidateSkillScore: number | null;
  readonly noSkillScore: number | null;
  readonly improvementPct: number | null;
  readonly summaryJson: Record<string, unknown>;
  readonly archiveUrl: string | null;
}

export interface CloudImproveReviewInput {
  readonly run: CloudRunInput;
  readonly winner: CloudCandidateInput | null;
  readonly latestApplyAttempt: { readonly success: boolean; readonly prUrl: string | null } | null;
  readonly skillName: string;
}

function score(value: number | null): string {
  return value === null ? "Not measured" : value.toFixed(3);
}

export function adaptCloudImproveRun(input: CloudImproveReviewInput): RunReviewView {
  const { run, winner, latestApplyAttempt } = input;
  const applied = latestApplyAttempt?.success === true;
  const failedApply = latestApplyAttempt?.success === false;
  const hasWinner = winner !== null;
  const outcomeState: RunReviewState = applied
    ? "applied"
    : failedApply
      ? "failed"
      : run.status === "no_winner"
        ? "no_change"
        : run.status.startsWith("failed")
          ? "failed"
          : "pending";
  const validationState: RunReviewState = hasWinner ? "passed" : "blocked";
  const surface = winner?.mutationSurface ?? "skill content";
  const summary = winner
    ? `Winning ${surface} candidate improved the score from ${score(winner.currentSkillScore)} to ${score(winner.candidateSkillScore)}.`
    : "No candidate passed the hosted improve comparison.";
  return {
    runId: run.id,
    producer: "cloud_improve",
    intent: {
      title: `Improve ${input.skillName}`,
      summary: `Evaluate candidate changes and apply the winning package to ${run.applyTarget}.`,
    },
    evidence: winner
      ? [
          { label: "Current score", value: score(winner.currentSkillScore) },
          { label: "Candidate score", value: score(winner.candidateSkillScore) },
          { label: "No-skill score", value: score(winner.noSkillScore) },
          {
            label: "Improvement",
            value: winner.improvementPct === null ? "Not measured" : `${winner.improvementPct}%`,
          },
        ]
      : [],
    candidate: {
      summary,
      diffText: winner?.diffText ?? null,
      ...(winner?.archiveUrl
        ? { artifact: { label: "Download candidate package", href: winner.archiveUrl } }
        : {}),
    },
    decision: {
      state: applied ? "applied" : hasWinner ? "pending" : outcomeState,
      summary: applied
        ? "The winning candidate was applied."
        : hasWinner
          ? "The winning candidate is ready for human review."
          : summary,
    },
    validation: {
      state: validationState,
      summary: hasWinner
        ? "The candidate beat the current skill and no-skill comparison."
        : "No candidate cleared the hosted validation gate.",
    },
    outcome: {
      state: outcomeState,
      summary: applied
        ? summary
        : failedApply
          ? "The latest apply attempt failed; the candidate remains reviewable."
          : summary,
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
