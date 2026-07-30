import {
  Catalog,
  CandidateStore,
  SynthesisDecision,
  type CandidateSnapshot,
  type LibrarySnapshot,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";

import {
  evaluateSynthesisCandidate,
  generateSynthesisCandidateSnapshot,
  invalidateSynthesisReleaseAuthority,
  loadCandidateSnapshot,
  materializeSynthesisDraft,
  materializeSynthesisRelease,
  requireDraftableSynthesisCandidate,
  saveCandidateSnapshot,
  type SynthesisOptions,
} from "../synthesis.js";
import { CLIError } from "../utils/cli-error.js";
import { collectLibraryObservationsEffect } from "./catalog.js";

export type EffectSynthesisOptions = Pick<
  SynthesisOptions,
  "configRoot" | "db" | "now" | "runCreatePublish"
>;

export interface SynthesisReviewInput {
  readonly candidateId: string;
  readonly action: "accept" | "reject" | "snooze" | "edit";
  readonly reason: string;
  readonly snoozedUntil?: string | null;
  readonly title?: string;
  readonly summary?: string;
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toSynthesisError(operation: string, cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  return new CLIError(
    `Library ${operation} failed: ${failureMessage(cause)}`,
    "OPERATION_FAILED",
    `selftune library ${operation.replace(".", " ")} --help`,
  );
}

function syncOperation<A>(operation: string, evaluate: () => A): Effect.Effect<A, CLIError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) => toSynthesisError(operation, cause),
  });
}

function promiseOperation<A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, CLIError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => toSynthesisError(operation, cause),
  });
}

function storeOperation<A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CLIError, R> {
  return Effect.mapError(effect, (cause) => toSynthesisError(operation, cause));
}

const loadSnapshot = (operation: string, configRoot?: string) =>
  syncOperation(operation, () => loadCandidateSnapshot(configRoot));

const saveSnapshot = (operation: string, snapshot: CandidateSnapshot, configRoot?: string) =>
  syncOperation(operation, () => saveCandidateSnapshot(snapshot, configRoot));

export const scanSynthesisCandidatesEffect = Effect.fn("selftune.runtime.library.synthesis.scan")(
  function* (options: EffectSynthesisOptions = {}) {
    const operation = "synthesize.scan";
    const store = yield* CandidateStore;
    const generated = yield* syncOperation(operation, () =>
      generateSynthesisCandidateSnapshot(options),
    );
    const persisted = yield* loadSnapshot(operation, options.configRoot);
    yield* storeOperation(operation, store.mergeSnapshot(persisted));
    const merged = yield* storeOperation(operation, store.mergeSnapshot(generated));
    yield* saveSnapshot(operation, merged, options.configRoot);
    return merged;
  },
);

export const reviewSynthesisCandidateEffect = Effect.fn(
  "selftune.runtime.library.synthesis.review",
)(function* (input: SynthesisReviewInput, options: EffectSynthesisOptions = {}) {
  const operation = "synthesize.review";
  const store = yield* CandidateStore;
  yield* storeOperation(
    operation,
    store.mergeSnapshot(yield* loadSnapshot(operation, options.configRoot)),
  );
  const candidate = yield* storeOperation(
    operation,
    store.decide({
      candidateId: input.candidateId,
      decision: SynthesisDecision.make({
        action: input.action,
        reason: input.reason,
        decidedAt: (options.now ?? new Date()).toISOString(),
        snoozedUntil: input.snoozedUntil ?? null,
      }),
      title: input.title,
      summary: input.summary,
    }),
  );
  yield* saveSnapshot(
    operation,
    yield* storeOperation(operation, store.snapshot),
    options.configRoot,
  );
  yield* syncOperation(operation, () =>
    invalidateSynthesisReleaseAuthority(input.candidateId, options.configRoot),
  );
  return candidate;
});

const reconcileCatalog = Effect.fn("selftune.runtime.library.synthesis.catalog")(function* (
  operation: string,
  options: EffectSynthesisOptions,
) {
  const catalog = yield* Catalog;
  const observations = yield* collectLibraryObservationsEffect({
    skillSetConfigRoot: options.configRoot,
  }).pipe(Effect.mapError((cause) => toSynthesisError(operation, cause)));
  return yield* storeOperation(operation, catalog.reconcile(observations));
});

export const draftSynthesisCandidateEffect = Effect.fn("selftune.runtime.library.synthesis.draft")(
  function* (candidateId: string, outputDir?: string, options: EffectSynthesisOptions = {}) {
    const operation = "synthesize.draft";
    const snapshot = yield* loadSnapshot(operation, options.configRoot);
    const candidate = yield* syncOperation(operation, () =>
      requireDraftableSynthesisCandidate(candidateId, snapshot),
    );
    let catalogSnapshot: LibrarySnapshot | undefined;
    if (candidate.skillNames.length > 0) {
      catalogSnapshot = yield* reconcileCatalog(operation, options);
    }
    const result = yield* syncOperation(operation, () =>
      materializeSynthesisDraft(
        candidate,
        snapshot,
        catalogSnapshot ?? null,
        outputDir,
        options.configRoot,
      ),
    );
    const store = yield* CandidateStore;
    yield* storeOperation(operation, store.mergeSnapshot(snapshot));
    yield* storeOperation(operation, store.markDrafted(candidateId));
    yield* saveSnapshot(
      operation,
      yield* storeOperation(operation, store.snapshot),
      options.configRoot,
    );
    yield* syncOperation(operation, () =>
      invalidateSynthesisReleaseAuthority(candidateId, options.configRoot),
    );
    return result;
  },
);

export const evaluateSynthesisCandidateEffect = Effect.fn(
  "selftune.runtime.library.synthesis.evaluate",
)(function* (candidateId: string, options: EffectSynthesisOptions = {}) {
  return yield* promiseOperation("synthesize.evaluate", () =>
    evaluateSynthesisCandidate(candidateId, options),
  );
});

export const releaseSynthesisCandidateEffect = Effect.fn(
  "selftune.runtime.library.synthesis.release",
)(function* (candidateId: string, options: EffectSynthesisOptions = {}) {
  const operation = "synthesize.release";
  const release = yield* syncOperation(operation, () =>
    materializeSynthesisRelease(candidateId, options),
  );
  const store = yield* CandidateStore;
  yield* storeOperation(
    operation,
    store.mergeSnapshot(yield* loadSnapshot(operation, options.configRoot)),
  );
  yield* storeOperation(operation, store.markReleased(candidateId));
  yield* saveSnapshot(
    operation,
    yield* storeOperation(operation, store.snapshot),
    options.configRoot,
  );
  return release;
});
