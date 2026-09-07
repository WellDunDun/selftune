import * as Effect from "effect/Effect";

import {
  draftSynthesisCandidateEffect,
  evaluateSynthesisCandidateEffect,
  releaseSynthesisCandidateEffect,
  reviewSynthesisCandidateEffect,
  scanSynthesisCandidatesEffect,
} from "./effect-synthesis.js";
import { loadCandidateSnapshot } from "../synthesis.js";
import { CLIError } from "../utils/cli-error.js";

export type LibrarySynthesisProgramInput =
  | { readonly operation: "synthesize.scan" }
  | { readonly operation: "synthesize.list" }
  | {
      readonly operation: "synthesize.review";
      readonly candidateId?: string;
      readonly action?: string;
      readonly reason?: string;
      readonly snoozedUntil?: string;
      readonly title?: string;
      readonly summary?: string;
    }
  | {
      readonly operation: "synthesize.draft";
      readonly candidateId?: string;
      readonly outputDir?: string;
    }
  | { readonly operation: "synthesize.evaluate"; readonly candidateId?: string }
  | { readonly operation: "synthesize.release"; readonly candidateId?: string };

type ReviewAction = "accept" | "reject" | "snooze" | "edit";

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

const requireCandidateId = Effect.fn("selftune.runtime.library.requireCandidateId")(function* (
  candidateId: string | undefined,
) {
  const value = candidateId?.trim();
  if (!value) {
    return yield* Effect.fail(new CLIError("--candidate-id is required.", "MISSING_FLAG"));
  }
  return value;
});

const requireReviewAction = Effect.fn("selftune.runtime.library.requireReviewAction")(function* (
  action: string | undefined,
) {
  switch (action) {
    case "accept":
    case "reject":
    case "snooze":
    case "edit":
      return action satisfies ReviewAction;
    default:
      return yield* Effect.fail(
        new CLIError("--action must be accept, reject, snooze, or edit.", "INVALID_FLAG"),
      );
  }
});

const requireReason = Effect.fn("selftune.runtime.library.requireReason")(function* (
  reason: string | undefined,
) {
  if (!reason?.trim()) {
    return yield* Effect.fail(
      new CLIError("--reason is required for decision history.", "MISSING_FLAG"),
    );
  }
  return reason;
});

export const runLibrarySynthesisOperation = Effect.fn(
  "selftune.runtime.library.synthesis.operation",
)(function* (input: LibrarySynthesisProgramInput) {
  switch (input.operation) {
    case "synthesize.scan": {
      const value = yield* scanSynthesisCandidatesEffect();
      return value;
    }
    case "synthesize.list": {
      const value = yield* Effect.try({
        try: () => loadCandidateSnapshot(),
        catch: (cause) => toSynthesisError(input.operation, cause),
      });
      return value;
    }
    case "synthesize.review": {
      const candidateId = yield* requireCandidateId(input.candidateId);
      const action = yield* requireReviewAction(input.action);
      const reason = yield* requireReason(input.reason);
      const value = yield* reviewSynthesisCandidateEffect({
        candidateId,
        action,
        reason,
        snoozedUntil: input.snoozedUntil,
        title: input.title,
        summary: input.summary,
      });
      return value;
    }
    case "synthesize.draft": {
      const candidateId = yield* requireCandidateId(input.candidateId);
      const value = yield* draftSynthesisCandidateEffect(candidateId, input.outputDir);
      return value;
    }
    case "synthesize.evaluate": {
      const candidateId = yield* requireCandidateId(input.candidateId);
      const value = yield* evaluateSynthesisCandidateEffect(candidateId);
      return value;
    }
    case "synthesize.release": {
      const candidateId = yield* requireCandidateId(input.candidateId);
      const value = yield* releaseSynthesisCandidateEffect(candidateId);
      return value;
    }
  }
});

export const runLibrarySynthesisProgram = Effect.fn("selftune.runtime.library.synthesis.run")(
  function* (input: LibrarySynthesisProgramInput) {
    const value = yield* runLibrarySynthesisOperation(input);
    return { operation: input.operation, value, text: JSON.stringify(value, null, 2) };
  },
);

export type LibrarySynthesisProgramResult = Effect.Success<
  ReturnType<typeof runLibrarySynthesisProgram>
>;
