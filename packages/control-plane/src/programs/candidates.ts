import * as Effect from "effect/Effect";

import { SynthesisDecision, type CandidateSnapshot } from "../domain";
import { CandidateStore } from "../services";

export const mergeCandidateSnapshot = Effect.fn("mergeCandidateSnapshot")(function* (
  snapshot: CandidateSnapshot,
) {
  return yield* (yield* CandidateStore).mergeSnapshot(snapshot);
});

export const decideCandidate = Effect.fn("decideCandidate")(function* (input: {
  candidateId: string;
  action: "accept" | "reject" | "snooze" | "edit";
  reason: string;
  decidedAt: string;
  snoozedUntil?: string | null;
  title?: string;
  summary?: string;
}) {
  const store = yield* CandidateStore;
  return yield* store.decide({
    candidateId: input.candidateId,
    decision: SynthesisDecision.make({
      action: input.action,
      reason: input.reason,
      decidedAt: input.decidedAt,
      snoozedUntil: input.snoozedUntil ?? null,
    }),
    title: input.title,
    summary: input.summary,
  });
});

export const markCandidateDrafted = Effect.fn("markCandidateDrafted")(function* (
  candidateId: string,
) {
  return yield* (yield* CandidateStore).markDrafted(candidateId);
});

export const markCandidateReleased = Effect.fn("markCandidateReleased")(function* (
  candidateId: string,
) {
  return yield* (yield* CandidateStore).markReleased(candidateId);
});
