import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type {
  CandidateNotFound,
  CandidateSnapshot,
  CandidateStoreUnavailable,
  SynthesisCandidate,
  SynthesisDecision,
} from "../domain";

export class CandidateStore extends Context.Service<
  CandidateStore,
  {
    readonly snapshot: Effect.Effect<CandidateSnapshot, CandidateStoreUnavailable>;
    readonly mergeSnapshot: (
      snapshot: CandidateSnapshot,
    ) => Effect.Effect<CandidateSnapshot, CandidateStoreUnavailable>;
    readonly decide: (input: {
      candidateId: string;
      decision: SynthesisDecision;
      title?: string;
      summary?: string;
    }) => Effect.Effect<SynthesisCandidate, CandidateNotFound | CandidateStoreUnavailable>;
    readonly markDrafted: (
      candidateId: string,
    ) => Effect.Effect<SynthesisCandidate, CandidateNotFound | CandidateStoreUnavailable>;
    readonly markReleased: (
      candidateId: string,
    ) => Effect.Effect<SynthesisCandidate, CandidateNotFound | CandidateStoreUnavailable>;
  }
>()("@selftune/control-plane/CandidateStore") {}
