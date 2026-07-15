import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { CandidateNotFound, CandidateSnapshot, type SynthesisCandidate } from "../domain";
import { CandidateStore } from "../services";

const emptySnapshot = CandidateSnapshot.make({
  snapshotId: "empty",
  evidenceVersion: 1,
  generatedAt: "1970-01-01T00:00:00.000Z",
  candidates: [],
});

const statusFor = (action: "accept" | "reject" | "snooze" | "edit") => {
  if (action === "accept") return "accepted" as const;
  if (action === "reject") return "rejected" as const;
  if (action === "snooze") return "snoozed" as const;
  return "pending" as const;
};

export const CandidateStoreMemory = Layer.effect(
  CandidateStore,
  Effect.gen(function* () {
    const current = yield* Ref.make(emptySnapshot);

    const updateCandidate = (
      candidateId: string,
      update: (value: SynthesisCandidate) => SynthesisCandidate,
    ) =>
      Ref.modify(current, (snapshot) => {
        const candidate = snapshot.candidates.find((item) => item.candidateId === candidateId);
        if (!candidate) return [null, snapshot] as const;
        const updated = update(candidate);
        return [
          updated,
          CandidateSnapshot.make({
            ...snapshot,
            candidates: snapshot.candidates.map((item) =>
              item.candidateId === candidateId ? updated : item,
            ),
          }),
        ] as const;
      }).pipe(
        Effect.flatMap((candidate) =>
          candidate
            ? Effect.succeed(candidate)
            : Effect.fail(new CandidateNotFound({ candidateId })),
        ),
      );

    return CandidateStore.of({
      snapshot: Ref.get(current),
      mergeSnapshot: Effect.fn("CandidateStoreMemory.mergeSnapshot")(function* (incoming) {
        return yield* Ref.modify(current, (stored) => {
          const prior = new Map(
            stored.candidates.map((candidate) => [candidate.candidateId, candidate]),
          );
          const candidates = incoming.candidates.map((candidate) => {
            const existing = prior.get(candidate.candidateId);
            return existing?.decision
              ? {
                  ...candidate,
                  status: existing.status,
                  decision: existing.decision,
                  decisionHistory: existing.decisionHistory,
                  title: existing.title,
                  summary: existing.summary,
                }
              : candidate;
          });
          const incomingIds = new Set(candidates.map((candidate) => candidate.candidateId));
          const reviewedTombstones = stored.candidates.filter(
            (candidate) => candidate.decision && !incomingIds.has(candidate.candidateId),
          );
          const merged = CandidateSnapshot.make({
            ...incoming,
            candidates: [...candidates, ...reviewedTombstones],
          });
          return [merged, merged] as const;
        });
      }),
      decide: Effect.fn("CandidateStoreMemory.decide")(function* ({
        candidateId,
        decision,
        title,
        summary,
      }) {
        return yield* updateCandidate(candidateId, (candidate) => ({
          ...candidate,
          title: title?.trim() || candidate.title,
          summary: summary?.trim() || candidate.summary,
          status: statusFor(decision.action),
          decision,
          decisionHistory: [...candidate.decisionHistory, decision],
        }));
      }),
      markDrafted: Effect.fn("CandidateStoreMemory.markDrafted")(function* (candidateId) {
        return yield* updateCandidate(candidateId, (candidate) => ({
          ...candidate,
          status: "drafted",
        }));
      }),
      markReleased: Effect.fn("CandidateStoreMemory.markReleased")(function* (candidateId) {
        return yield* updateCandidate(candidateId, (candidate) => ({
          ...candidate,
          status: "released",
        }));
      }),
    });
  }),
);
