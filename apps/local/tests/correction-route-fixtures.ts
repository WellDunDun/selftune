import type {
  ExplicitCorrectionStudyRequest,
  CorrectionStudyServiceResponse,
} from "../src/correction-study-service.js";
import type { ExplicitCorrectionSignal } from "@selftune/runtime/correction-study/signal-discovery";

export const studyRequest = {
  episode: {
    skill_id: "release-checklist",
    skill_name: "release-checklist",
    skill_path: "/tmp/release-checklist/SKILL.md",
    task: "Prepare release",
    observed_failure: "Upload was not confirmed",
    correction_intent: "Check portal confirmation",
    pre_edit_revision: "a".repeat(64),
    post_edit_revision: "b".repeat(64),
    bounded_diff: "Add confirmation check",
    provenance: { harness: "codex", trace_id: "trace-1", session_id: "session-1" },
    captured_at: "2026-09-06T10:00:00Z",
  },
  verifier: {
    verifier_id: "portal-check",
    version: "v1",
    kind: "deterministic",
    qualification: { rejects_known_failure: true, accepts_known_good: true },
  },
  trials: [],
} satisfies ExplicitCorrectionStudyRequest;

export const studyResponse = {
  episode_id: "episode-1",
  skill_id: "release-checklist",
  skill_name: "release-checklist",
  evidence_level: "E0.5",
  status: "inconclusive",
  reason: "Insufficient scored pairs",
  manifest_id: "manifest-1",
  replay: {
    source: "externally_supplied",
    verified_by_selftune: false,
    minimum_scored_trials: 3,
    scored_pairs: 0,
    censored_pairs: 0,
    censored_attempts: 0,
  },
  regression_case: null,
  applies_change: false,
} satisfies CorrectionStudyServiceResponse;

export const correctionSignal = {
  candidate_id: "signal-1",
  kind: "explicit_correction_hypothesis",
  review_status: "review_required",
  dry_run: true,
  evidence_level: "E0",
  reason: "missing_revision_evidence",
  skill: {
    name: "release-checklist",
    path: "[local-path-redacted]",
    pre_revision: null,
    post_revision: null,
  },
  source: {
    harness: "codex",
    session_id: "session-1",
    prompt_id: "prompt-1",
    skill_invocation_id: "invocation-1",
    raw_source_ref_digest: null,
  },
  raw_edit_digest: null,
  raw_content_digests: null,
  deferred_skill_names: null,
  correlation_truncated: false,
  correction_intent: "Check portal confirmation",
  intent_detection: "heuristic",
  proves_causality: false,
} satisfies ExplicitCorrectionSignal;
