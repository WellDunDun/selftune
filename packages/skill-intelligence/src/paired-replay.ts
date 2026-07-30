import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { VerifierQualificationResult } from "./verifier-instruments.js";

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_000));

export const PairedReplayTaskCase = Schema.Struct({
  case_id: Identifier,
  task_payload: BoundedText,
  task_fingerprint: Sha256,
});
export type PairedReplayTaskCase = typeof PairedReplayTaskCase.Type;

export const PairedReplayRuntime = Schema.Struct({
  harness: Identifier,
  model: Identifier,
  config_digest: Sha256,
});
export type PairedReplayRuntime = typeof PairedReplayRuntime.Type;

export const ManagedPairedReplayProtocol = Schema.Struct({
  task_case: PairedReplayTaskCase,
  qualified_verifier: VerifierQualificationResult,
  pre_edit_revision: Schema.String.check(Schema.isMaxLength(128)),
  post_edit_revision: Schema.String.check(Schema.isMaxLength(128)),
  current_revision: Schema.String.check(Schema.isMaxLength(128)),
  runtime: PairedReplayRuntime,
  required_scored_repetitions: Schema.Number,
  max_attempts_per_arm: Schema.Number,
});
export type ManagedPairedReplayProtocol = typeof ManagedPairedReplayProtocol.Type;

export const ReplayArm = Schema.Literals(["pre_edit", "post_edit"]);
export type ReplayArm = typeof ReplayArm.Type;
export const ReplayInfrastructureCategory = Schema.Literals([
  "rate_limit",
  "provider_error",
  "network",
  "sandbox_infra",
]);

export const ReplayScoredAttempt = Schema.Struct({
  kind: Schema.Literal("scored"),
  passed: Schema.Boolean,
  executed_revision: Revision,
});
export const ReplayInfrastructureAttempt = Schema.Struct({
  kind: Schema.Literal("infrastructure"),
  category: ReplayInfrastructureCategory,
  retryable: Schema.Boolean,
});
export const ReplayCancelledAttempt = Schema.Struct({ kind: Schema.Literal("cancelled") });
export const ReplayBudgetExhaustedAttempt = Schema.Struct({
  kind: Schema.Literal("budget_exhausted"),
});
export const ReplayArmAttempt = Schema.Union([
  ReplayScoredAttempt,
  ReplayInfrastructureAttempt,
  ReplayCancelledAttempt,
  ReplayBudgetExhaustedAttempt,
]);
export type ReplayArmAttempt = typeof ReplayArmAttempt.Type;

export class PairedReplayExecutionFailure extends Schema.TaggedErrorClass<PairedReplayExecutionFailure>()(
  "PairedReplayExecutionFailure",
  {
    kind: Schema.Literals(["infrastructure", "cancelled", "budget_exhausted"]),
    message: Schema.String,
    retryable: Schema.Boolean,
    category: Schema.NullOr(ReplayInfrastructureCategory),
  },
) {}

export interface PairedReplayArmExecutor {
  readonly execute: (request: {
    readonly task_case: PairedReplayTaskCase;
    readonly runtime: PairedReplayRuntime;
    readonly verifier_id: string;
    readonly verifier_version: string;
    readonly arm: ReplayArm;
    readonly revision: string;
    readonly repetition: number;
    readonly attempt: number;
  }) => Effect.Effect<ReplayArmAttempt, PairedReplayExecutionFailure>;
}

export const ManagedPairedReplayStatus = Schema.Literals(["promoted", "inconclusive", "invalid"]);
export const ManagedPairedReplayReason = Schema.Literals([
  "promoted",
  "unqualified_verifier",
  "judge_verifier_not_supported",
  "task_fingerprint_mismatch",
  "invalid_protocol_budget",
  "invalid_revision_pins",
  "stale_current_revision",
  "executor_revision_mismatch",
  "old_unexpectedly_passing",
  "corrected_failing",
  "mixed_replay_results",
  "insufficient_scored_repetitions",
  "cancelled",
  "budget_exhausted",
]);
export const ManagedPairedReplayTrial = Schema.Struct({
  pair_id: Identifier,
  pre_edit: Schema.Literals(["pass", "fail", "infrastructure_error", "skipped"]),
  post_edit: Schema.Literals(["pass", "fail", "infrastructure_error", "skipped"]),
  pre_edit_attempts: Schema.Number,
  post_edit_attempts: Schema.Number,
  censored_attempts: Schema.Number,
});
export type ManagedPairedReplayTrial = typeof ManagedPairedReplayTrial.Type;

export const ManagedPairedReplayResult = Schema.Struct({
  run_id: Identifier,
  manifest_id: Identifier,
  status: ManagedPairedReplayStatus,
  reason: ManagedPairedReplayReason,
  required_scored_repetitions: Schema.Number,
  scored_pairs: Schema.Number,
  censored_attempts: Schema.Number,
  trials: Schema.Array(ManagedPairedReplayTrial),
  applies_change: Schema.Literal(false),
});
export type ManagedPairedReplayResult = typeof ManagedPairedReplayResult.Type;

type ArmRun =
  | { kind: "scored"; passed: boolean; attempts: number; censored: number }
  | { kind: "infra_exhausted"; attempts: number; censored: number }
  | { kind: "cancelled"; attempts: number; censored: number }
  | { kind: "budget_exhausted"; attempts: number; censored: number }
  | { kind: "revision_mismatch"; attempts: number; censored: number }
  | { kind: "skipped"; attempts: 0; censored: 0 };

function stableId(prefix: string, canonical: string): string {
  return `${prefix}-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function manifest(input: ManagedPairedReplayProtocol): string {
  return JSON.stringify({
    task_case: input.task_case,
    qualified_verifier: input.qualified_verifier,
    pre_edit_revision: input.pre_edit_revision,
    post_edit_revision: input.post_edit_revision,
    current_revision: input.current_revision,
    runtime: input.runtime,
    required_scored_repetitions: input.required_scored_repetitions,
    max_attempts_per_arm: input.max_attempts_per_arm,
  });
}

function exactRevision(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function taskFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function invalidReason(
  input: ManagedPairedReplayProtocol,
): typeof ManagedPairedReplayReason.Type | null {
  if (
    input.qualified_verifier.status !== "qualified" ||
    input.qualified_verifier.reasons.length !== 1 ||
    input.qualified_verifier.reasons[0] !== "qualified"
  ) {
    return "unqualified_verifier";
  }
  if (input.qualified_verifier.instrument.kind !== "deterministic") {
    return "judge_verifier_not_supported";
  }
  if (!exactRevision(input.pre_edit_revision) || !exactRevision(input.post_edit_revision)) {
    return "invalid_revision_pins";
  }
  if (input.pre_edit_revision === input.post_edit_revision) return "invalid_revision_pins";
  if (input.current_revision !== input.post_edit_revision) return "stale_current_revision";
  if (input.task_case.task_fingerprint !== taskFingerprint(input.task_case.task_payload)) {
    return "task_fingerprint_mismatch";
  }
  if (
    !Number.isInteger(input.required_scored_repetitions) ||
    input.required_scored_repetitions < 3 ||
    input.required_scored_repetitions > 32 ||
    !Number.isInteger(input.max_attempts_per_arm) ||
    input.max_attempts_per_arm < input.required_scored_repetitions ||
    input.max_attempts_per_arm > 64
  ) {
    return "invalid_protocol_budget";
  }
  return null;
}

function result(input: {
  manifest_id: string;
  status: typeof ManagedPairedReplayStatus.Type;
  reason: typeof ManagedPairedReplayReason.Type;
  required_scored_repetitions: number;
  trials: ManagedPairedReplayTrial[];
}): ManagedPairedReplayResult {
  const scoredPairs = input.trials.filter(
    (trial) =>
      (trial.pre_edit === "pass" || trial.pre_edit === "fail") &&
      (trial.post_edit === "pass" || trial.post_edit === "fail"),
  ).length;
  const censoredAttempts = input.trials.reduce(
    (total, trial) => total + trial.censored_attempts,
    0,
  );
  const canonicalRun = JSON.stringify({
    manifest_id: input.manifest_id,
    status: input.status,
    reason: input.reason,
    trials: input.trials,
  });
  return ManagedPairedReplayResult.make({
    run_id: stableId("paired-replay-run", canonicalRun),
    manifest_id: input.manifest_id,
    status: input.status,
    reason: input.reason,
    required_scored_repetitions: input.required_scored_repetitions,
    scored_pairs: scoredPairs,
    censored_attempts: censoredAttempts,
    trials: input.trials,
    applies_change: false,
  });
}

function toFailureAttempt(failure: PairedReplayExecutionFailure): ReplayArmAttempt {
  if (failure.kind === "cancelled") return { kind: "cancelled" };
  if (failure.kind === "budget_exhausted") return { kind: "budget_exhausted" };
  return {
    kind: "infrastructure",
    category: failure.category ?? "provider_error",
    retryable: failure.retryable,
  };
}

function runArm(input: {
  executor: PairedReplayArmExecutor;
  protocol: ManagedPairedReplayProtocol;
  arm: ReplayArm;
  revision: string;
  repetition: number;
}): Effect.Effect<ArmRun> {
  return Effect.gen(function* () {
    let censored = 0;
    for (let attempt = 1; attempt <= input.protocol.max_attempts_per_arm; attempt += 1) {
      const outcome = yield* input.executor
        .execute({
          task_case: input.protocol.task_case,
          runtime: input.protocol.runtime,
          verifier_id: input.protocol.qualified_verifier.instrument.verifier_id,
          verifier_version: input.protocol.qualified_verifier.instrument.version,
          arm: input.arm,
          revision: input.revision,
          repetition: input.repetition,
          attempt,
        })
        .pipe(
          Effect.catchTag("PairedReplayExecutionFailure", (failure) =>
            Effect.succeed(toFailureAttempt(failure)),
          ),
        );
      if (outcome.kind === "scored") {
        if (outcome.executed_revision !== input.revision) {
          return { kind: "revision_mismatch", attempts: attempt, censored };
        }
        return { kind: "scored", passed: outcome.passed, attempts: attempt, censored };
      }
      if (outcome.kind === "cancelled") return { kind: "cancelled", attempts: attempt, censored };
      if (outcome.kind === "budget_exhausted") {
        return { kind: "budget_exhausted", attempts: attempt, censored };
      }
      censored += 1;
      if (!outcome.retryable) return { kind: "infra_exhausted", attempts: attempt, censored };
    }
    return {
      kind: "infra_exhausted",
      attempts: input.protocol.max_attempts_per_arm,
      censored,
    };
  });
}

function trialOutcome(arm: ArmRun): "pass" | "fail" | "infrastructure_error" | "skipped" {
  if (arm.kind === "skipped") return "skipped";
  if (arm.kind !== "scored") return "infrastructure_error";
  return arm.passed ? "pass" : "fail";
}

function skippedArm(): ArmRun {
  return { kind: "skipped", attempts: 0, censored: 0 };
}

function terminalReason(
  arm: ArmRun,
): typeof ManagedPairedReplayReason.Type | "insufficient_scored_repetitions" | null {
  if (arm.kind === "revision_mismatch") return "executor_revision_mismatch";
  if (arm.kind === "cancelled") return "cancelled";
  if (arm.kind === "budget_exhausted") return "budget_exhausted";
  if (arm.kind === "infra_exhausted") return "insufficient_scored_repetitions";
  return null;
}

/**
 * Executes frozen, same-case old/new pairs through an injected executor. It
 * never alters a skill; a promoted result is evidence for a later lifecycle.
 */
export function runManagedPairedReplay(
  protocol: ManagedPairedReplayProtocol,
  executor: PairedReplayArmExecutor,
): Effect.Effect<ManagedPairedReplayResult> {
  return Effect.gen(function* () {
    const manifestId = stableId("paired-replay-manifest", manifest(protocol));
    const invalid = invalidReason(protocol);
    if (invalid) {
      return result({
        manifest_id: manifestId,
        status: "invalid",
        reason: invalid,
        required_scored_repetitions: protocol.required_scored_repetitions,
        trials: [],
      });
    }

    const trials: ManagedPairedReplayTrial[] = [];
    for (let repetition = 1; repetition <= protocol.required_scored_repetitions; repetition += 1) {
      const pre = yield* runArm({
        executor,
        protocol,
        arm: "pre_edit",
        revision: protocol.pre_edit_revision,
        repetition,
      });
      const post =
        pre.kind === "scored"
          ? yield* runArm({
              executor,
              protocol,
              arm: "post_edit",
              revision: protocol.post_edit_revision,
              repetition,
            })
          : skippedArm();
      trials.push(
        ManagedPairedReplayTrial.make({
          pair_id: `pair-${repetition}`,
          pre_edit: trialOutcome(pre),
          post_edit: trialOutcome(post),
          pre_edit_attempts: pre.attempts,
          post_edit_attempts: post.attempts,
          censored_attempts: pre.censored + post.censored,
        }),
      );
      const terminal = terminalReason(pre) ?? terminalReason(post);
      if (terminal) {
        return result({
          manifest_id: manifestId,
          status: terminal === "executor_revision_mismatch" ? "invalid" : "inconclusive",
          reason: terminal,
          required_scored_repetitions: protocol.required_scored_repetitions,
          trials,
        });
      }
    }

    const preOutcomes = trials.map((trial) => trial.pre_edit);
    const postOutcomes = trials.map((trial) => trial.post_edit);
    if (preOutcomes.every((outcome) => outcome === "pass")) {
      return result({
        manifest_id: manifestId,
        status: "inconclusive",
        reason: "old_unexpectedly_passing",
        required_scored_repetitions: protocol.required_scored_repetitions,
        trials,
      });
    }
    if (postOutcomes.every((outcome) => outcome === "fail")) {
      return result({
        manifest_id: manifestId,
        status: "inconclusive",
        reason: "corrected_failing",
        required_scored_repetitions: protocol.required_scored_repetitions,
        trials,
      });
    }
    if (!trials.every((trial) => trial.pre_edit === "fail" && trial.post_edit === "pass")) {
      return result({
        manifest_id: manifestId,
        status: "inconclusive",
        reason: "mixed_replay_results",
        required_scored_repetitions: protocol.required_scored_repetitions,
        trials,
      });
    }
    return result({
      manifest_id: manifestId,
      status: "promoted",
      reason: "promoted",
      required_scored_repetitions: protocol.required_scored_repetitions,
      trials,
    });
  });
}
