import {
  Catalog,
  CatalogMemory,
  CandidateStore,
  CandidateStoreMemory,
  decideCandidate,
  markCandidateDrafted,
  markCandidateReleased,
  mergeCandidateSnapshot,
  reconcileLibrary,
  type CandidateSnapshot,
  type LibraryObservation,
  type LibrarySnapshot,
  type SynthesisCandidate,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

export interface ControlPlaneRuntime {
  reconcile: (observations: ReadonlyArray<LibraryObservation>) => Promise<LibrarySnapshot>;
  snapshot: () => Promise<LibrarySnapshot>;
  candidateSnapshot: () => Promise<CandidateSnapshot>;
  mergeCandidates: (snapshot: CandidateSnapshot) => Promise<CandidateSnapshot>;
  decideCandidate: (input: {
    candidateId: string;
    action: "accept" | "reject" | "snooze" | "edit";
    reason: string;
    decidedAt: string;
    snoozedUntil?: string | null;
    title?: string;
    summary?: string;
  }) => Promise<SynthesisCandidate>;
  markCandidateDrafted: (candidateId: string) => Promise<SynthesisCandidate>;
  markCandidateReleased: (candidateId: string) => Promise<SynthesisCandidate>;
  dispose: () => Promise<void>;
}

export function createControlPlaneRuntime(): ControlPlaneRuntime {
  const runtime = ManagedRuntime.make(Layer.merge(CatalogMemory, CandidateStoreMemory));
  return {
    reconcile: (observations) => runtime.runPromise(reconcileLibrary(observations)),
    snapshot: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const catalog = yield* Catalog;
          return yield* catalog.snapshot;
        }),
      ),
    candidateSnapshot: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* CandidateStore).snapshot;
        }),
      ),
    mergeCandidates: (snapshot) => runtime.runPromise(mergeCandidateSnapshot(snapshot)),
    decideCandidate: (input) => runtime.runPromise(decideCandidate(input)),
    markCandidateDrafted: (candidateId) => runtime.runPromise(markCandidateDrafted(candidateId)),
    markCandidateReleased: (candidateId) => runtime.runPromise(markCandidateReleased(candidateId)),
    dispose: () => runtime.dispose(),
  };
}
