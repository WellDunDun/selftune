import { createHash } from "node:crypto";

export const CORRECTION_STUDY_MAX_TEXT_LENGTH = 12_000;
export const CORRECTION_STUDY_MAX_DIFF_LENGTH = 20_000;
export const CORRECTION_STUDY_MAX_PROVENANCE_LENGTH = 512;
export const CORRECTION_STUDY_MAX_PAIR_ID_LENGTH = 512;

/**
 * Pure, immutable input captured when a user corrects an agent and changes an
 * existing skill. Capturing an episode is evidence, not permission to mutate
 * the skill again.
 */
export interface CorrectionEpisode {
  episode_id: string;
  skill_id: string;
  task: string;
  observed_failure: string;
  correction_intent: string;
  pre_edit_revision: string;
  post_edit_revision: string;
  bounded_diff: string;
  provenance: CorrectionEpisodeProvenance;
}

export interface CorrectionEpisodeProvenance {
  harness: string;
  trace_id: string;
  session_id: string;
}

/** A qualified verifier must reject the known failure and accept known-good work. */
export interface VerifierInstrument {
  verifier_id: string;
  version: string;
  kind: "deterministic";
  qualification: {
    rejects_known_failure: boolean;
    accepts_known_good: boolean;
  };
}

export type ReplayTrialOutcome = "pass" | "fail" | "infrastructure_error";

/**
 * One paired replay uses the same frozen task configuration for both exact
 * revisions. Infrastructure failures are deliberately not quality outcomes.
 */
export interface PairedReplayTrial {
  pair_id: string;
  pre_edit: ReplayTrialOutcome;
  post_edit: ReplayTrialOutcome;
}

export interface EvaluateCorrectionStudyInput {
  episode: CorrectionEpisode;
  verifier: VerifierInstrument;
  trials: ReadonlyArray<PairedReplayTrial>;
  minimum_scored_trials?: number;
}

export type CorrectionStudyEvidenceLevel = "E0.5" | "E1";
export type CorrectionStudyStatus = "promoted" | "inconclusive" | "invalid";
export type CorrectionStudyReason =
  | "promoted"
  | "insufficient_scored_trials"
  | "mixed_replay_results"
  | "invalid_verifier"
  | "invalid_episode"
  | "invalid_trial_ids";

export interface CorrectionStudyEvaluation {
  status: CorrectionStudyStatus;
  reason: CorrectionStudyReason;
  evidence_level: CorrectionStudyEvidenceLevel;
  manifest_id: string;
  case_id: string | null;
  minimum_scored_trials: number;
  pre_edit_scored_trials: number;
  post_edit_scored_trials: number;
  censored_pairs: number;
  scored_pairs: number;
  /** This evaluator is intentionally observational; it never applies a diff. */
  applies_change: false;
}

function stableId(prefix: string, canonicalValue: string): string {
  return `${prefix}-${createHash("sha256").update(canonicalValue).digest("hex").slice(0, 16)}`;
}

function isBoundedText(value: string, maximumLength: number): boolean {
  return value.trim().length > 0 && value.length <= maximumLength;
}

function isExactRevision(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validEpisode(episode: CorrectionEpisode): boolean {
  const text = [
    episode.episode_id,
    episode.skill_id,
    episode.task,
    episode.observed_failure,
    episode.correction_intent,
  ];
  const provenance = [
    episode.provenance.harness,
    episode.provenance.trace_id,
    episode.provenance.session_id,
  ];
  return (
    text.every((value) => isBoundedText(value, CORRECTION_STUDY_MAX_TEXT_LENGTH)) &&
    isBoundedText(episode.bounded_diff, CORRECTION_STUDY_MAX_DIFF_LENGTH) &&
    provenance.every((value) => isBoundedText(value, CORRECTION_STUDY_MAX_PROVENANCE_LENGTH)) &&
    isExactRevision(episode.pre_edit_revision) &&
    isExactRevision(episode.post_edit_revision) &&
    episode.pre_edit_revision !== episode.post_edit_revision
  );
}

function validTrialIds(trials: ReadonlyArray<PairedReplayTrial>): boolean {
  const ids = trials.map((trial) => trial.pair_id);
  return (
    ids.every((id) => isBoundedText(id, CORRECTION_STUDY_MAX_PAIR_ID_LENGTH)) &&
    new Set(ids).size === ids.length
  );
}

function episodeManifestValue(episode: CorrectionEpisode) {
  return {
    episode_id: episode.episode_id,
    skill_id: episode.skill_id,
    task: episode.task,
    observed_failure: episode.observed_failure,
    correction_intent: episode.correction_intent,
    pre_edit_revision: episode.pre_edit_revision,
    post_edit_revision: episode.post_edit_revision,
    bounded_diff: episode.bounded_diff,
    provenance: {
      harness: episode.provenance.harness,
      trace_id: episode.provenance.trace_id,
      session_id: episode.provenance.session_id,
    },
  };
}

function verifierManifestValue(verifier: VerifierInstrument) {
  return {
    verifier_id: verifier.verifier_id,
    version: verifier.version,
    kind: verifier.kind,
    qualification: {
      rejects_known_failure: verifier.qualification.rejects_known_failure,
      accepts_known_good: verifier.qualification.accepts_known_good,
    },
  };
}

function manifestFor(input: EvaluateCorrectionStudyInput, minimumScoredTrials: number): string {
  const canonicalManifest = JSON.stringify({
    episode: episodeManifestValue(input.episode),
    verifier: verifierManifestValue(input.verifier),
    minimum_scored_trials: minimumScoredTrials,
    trials: [...input.trials]
      .toSorted((left, right) => left.pair_id.localeCompare(right.pair_id))
      .map((trial) => ({
        pair_id: trial.pair_id,
        pre_edit: trial.pre_edit,
        post_edit: trial.post_edit,
      })),
  });
  return stableId("correction-study-manifest", canonicalManifest);
}

function evaluation(
  fields: Omit<CorrectionStudyEvaluation, "applies_change">,
): CorrectionStudyEvaluation {
  return { ...fields, applies_change: false };
}

/**
 * Decide whether an explicit correction may become a regression case. The
 * caller owns persistence and any later review/application policy.
 */
export function evaluateCorrectionStudy(
  input: EvaluateCorrectionStudyInput,
): CorrectionStudyEvaluation {
  const minimumScoredTrials = Math.max(3, input.minimum_scored_trials ?? 3);
  const manifestId = manifestFor(input, minimumScoredTrials);
  const censored = input.trials.filter(
    (trial) =>
      trial.pre_edit === "infrastructure_error" || trial.post_edit === "infrastructure_error",
  );
  const scored = input.trials.filter(
    (trial) =>
      trial.pre_edit !== "infrastructure_error" && trial.post_edit !== "infrastructure_error",
  );
  const preScored = scored.length;
  const postScored = scored.length;
  const shared = {
    manifest_id: manifestId,
    minimum_scored_trials: minimumScoredTrials,
    pre_edit_scored_trials: preScored,
    post_edit_scored_trials: postScored,
    censored_pairs: censored.length,
    scored_pairs: scored.length,
  };

  if (!validEpisode(input.episode)) {
    return evaluation({
      status: "invalid",
      reason: "invalid_episode",
      evidence_level: "E0.5",
      case_id: null,
      ...shared,
    });
  }
  if (!validTrialIds(input.trials)) {
    return evaluation({
      status: "invalid",
      reason: "invalid_trial_ids",
      evidence_level: "E0.5",
      case_id: null,
      ...shared,
    });
  }
  if (
    input.verifier.kind !== "deterministic" ||
    !input.verifier.qualification.rejects_known_failure ||
    !input.verifier.qualification.accepts_known_good
  ) {
    return evaluation({
      status: "invalid",
      reason: "invalid_verifier",
      evidence_level: "E0.5",
      case_id: null,
      ...shared,
    });
  }
  if (scored.length < minimumScoredTrials) {
    return evaluation({
      status: "inconclusive",
      reason: "insufficient_scored_trials",
      evidence_level: "E0.5",
      case_id: null,
      ...shared,
    });
  }
  const stableCorrection = scored.every(
    (trial) => trial.pre_edit === "fail" && trial.post_edit === "pass",
  );
  if (!stableCorrection) {
    return evaluation({
      status: "inconclusive",
      reason: "mixed_replay_results",
      evidence_level: "E0.5",
      case_id: null,
      ...shared,
    });
  }
  return evaluation({
    status: "promoted",
    reason: "promoted",
    evidence_level: "E1",
    case_id: stableId("correction-study-case", manifestId),
    ...shared,
  });
}
