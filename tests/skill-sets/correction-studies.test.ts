import { describe, expect, test } from "bun:test";

import {
  evaluateCorrectionStudy,
  type CorrectionEpisode,
  type PairedReplayTrial,
  type VerifierInstrument,
} from "@selftune/skill-intelligence/correction-studies";

const episode: CorrectionEpisode = {
  episode_id: "episode-1",
  skill_id: "release-checklist",
  task: "Prepare the private beta release checklist.",
  observed_failure: "The agent treated a selected Steam image as uploaded.",
  correction_intent: "Require portal status confirmation before saying the asset is uploaded.",
  pre_edit_revision: "a".repeat(64),
  post_edit_revision: "b".repeat(64),
  bounded_diff: "Add the portal-status confirmation instruction to the upload step.",
  provenance: {
    harness: "codex",
    trace_id: "trace-1",
    session_id: "session-1",
  },
};

const verifier: VerifierInstrument = {
  verifier_id: "portal-status",
  version: "1",
  kind: "deterministic",
  qualification: {
    rejects_known_failure: true,
    accepts_known_good: true,
  },
};

const passingTrials: PairedReplayTrial[] = ["a", "b", "c"].map((pair_id) => ({
  pair_id,
  pre_edit: "fail",
  post_edit: "pass",
}));

function passingTrial(index: number): PairedReplayTrial {
  const trial = passingTrials[index];
  if (!trial) throw new Error(`Missing passing trial fixture at index ${index}.`);
  return trial;
}

describe("correction studies", () => {
  test("promotes a stable, qualified correction into an E1 regression case", () => {
    const result = evaluateCorrectionStudy({ episode, verifier, trials: passingTrials });

    expect(result).toMatchObject({
      status: "promoted",
      reason: "promoted",
      evidence_level: "E1",
      pre_edit_scored_trials: 3,
      post_edit_scored_trials: 3,
      censored_pairs: 0,
      applies_change: false,
    });
    expect(result.case_id).toMatch(/^correction-study-case-/);
    expect(result.manifest_id).toMatch(/^correction-study-manifest-/);
  });

  test("is inconclusive when either arm has fewer than three scored paired trials", () => {
    const result = evaluateCorrectionStudy({
      episode,
      verifier,
      trials: passingTrials.slice(0, 2),
    });

    expect(result).toMatchObject({
      status: "inconclusive",
      reason: "insufficient_scored_trials",
      evidence_level: "E0.5",
      case_id: null,
    });
  });

  test("invalidates an episode when the deterministic verifier cannot prove both controls", () => {
    const result = evaluateCorrectionStudy({
      episode,
      verifier: {
        ...verifier,
        qualification: { rejects_known_failure: true, accepts_known_good: false },
      },
      trials: passingTrials,
    });

    expect(result).toMatchObject({
      status: "invalid",
      reason: "invalid_verifier",
      evidence_level: "E0.5",
      case_id: null,
    });
  });

  test("requires distinct, exact lowercase SHA-256 revision pins", () => {
    const malformed = evaluateCorrectionStudy({
      episode: { ...episode, pre_edit_revision: "A".repeat(64) },
      verifier,
      trials: passingTrials,
    });
    const identical = evaluateCorrectionStudy({
      episode: { ...episode, post_edit_revision: episode.pre_edit_revision },
      verifier,
      trials: passingTrials,
    });

    expect(malformed).toMatchObject({ status: "invalid", reason: "invalid_episode" });
    expect(identical).toMatchObject({ status: "invalid", reason: "invalid_episode" });
  });

  test("rejects oversized correction text, diff, and provenance rather than hashing unbounded evidence", () => {
    const oversizedText = evaluateCorrectionStudy({
      episode: { ...episode, task: "x".repeat(12_001) },
      verifier,
      trials: passingTrials,
    });
    const oversizedProvenance = evaluateCorrectionStudy({
      episode: { ...episode, provenance: { ...episode.provenance, trace_id: "x".repeat(513) } },
      verifier,
      trials: passingTrials,
    });
    const oversizedDiff = evaluateCorrectionStudy({
      episode: { ...episode, bounded_diff: "x".repeat(20_001) },
      verifier,
      trials: passingTrials,
    });

    expect(oversizedText).toMatchObject({ status: "invalid", reason: "invalid_episode" });
    expect(oversizedProvenance).toMatchObject({ status: "invalid", reason: "invalid_episode" });
    expect(oversizedDiff).toMatchObject({ status: "invalid", reason: "invalid_episode" });
  });

  test("rejects blank and duplicate pair IDs so repeated rows cannot manufacture trial evidence", () => {
    const blank = evaluateCorrectionStudy({
      episode,
      verifier,
      trials: [{ ...passingTrial(0), pair_id: " " }, ...passingTrials.slice(1)],
    });
    const duplicate = evaluateCorrectionStudy({
      episode,
      verifier,
      trials: [
        passingTrial(0),
        passingTrial(1),
        { ...passingTrial(2), pair_id: passingTrial(1).pair_id },
      ],
    });

    expect(blank).toMatchObject({ status: "invalid", reason: "invalid_trial_ids" });
    expect(duplicate).toMatchObject({ status: "invalid", reason: "invalid_trial_ids" });
  });

  test("censors infrastructure pairs and still promotes when three quality pairs remain", () => {
    const result = evaluateCorrectionStudy({
      episode,
      verifier,
      trials: [
        ...passingTrials,
        { pair_id: "network", pre_edit: "infrastructure_error", post_edit: "pass" },
      ],
    });

    expect(result).toMatchObject({
      status: "promoted",
      censored_pairs: 1,
      scored_pairs: 3,
      applies_change: false,
    });
  });

  test("keeps mixed old/new replay evidence inconclusive", () => {
    const result = evaluateCorrectionStudy({
      episode,
      verifier,
      trials: [
        ...passingTrials.slice(0, 2),
        { pair_id: "mixed", pre_edit: "fail", post_edit: "fail" },
      ],
    });

    expect(result).toMatchObject({
      status: "inconclusive",
      reason: "mixed_replay_results",
      evidence_level: "E0.5",
      case_id: null,
    });
  });

  test("uses deterministic manifest and case identities regardless of trial ordering", () => {
    const first = evaluateCorrectionStudy({ episode, verifier, trials: passingTrials });
    const second = evaluateCorrectionStudy({
      episode,
      verifier,
      trials: passingTrials.toReversed(),
    });

    expect(second.manifest_id).toBe(first.manifest_id);
    expect(second.case_id).toBe(first.case_id);
  });
});
