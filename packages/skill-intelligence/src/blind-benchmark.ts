import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { VerifierQualificationResult } from "./verifier-instruments.js";

const Identifier = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const BoundedText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_000));

export const BlindBenchmarkPartition = Schema.Literals([
  "calibration",
  "selection",
  "audit_holdout",
]);
export const BlindBenchmarkArm = Schema.Literals(["no_skill", "current_skill", "candidate_skill"]);
export type BlindBenchmarkArm = typeof BlindBenchmarkArm.Type;

export const BlindBenchmarkCase = Schema.Struct({
  case_id: Identifier,
  task_payload: BoundedText,
  task_fingerprint: Sha256,
  partition: BlindBenchmarkPartition,
  regression_case: Schema.Boolean,
});
export type BlindBenchmarkCase = typeof BlindBenchmarkCase.Type;

export const BlindBenchmarkProtocol = Schema.Struct({
  cases: Schema.Array(BlindBenchmarkCase).check(Schema.isMaxLength(64)),
  candidate_generation_case_ids: Schema.Array(Identifier).check(Schema.isMaxLength(64)),
  qualified_verifier: VerifierQualificationResult,
  current_revision: Schema.String.check(Schema.isMaxLength(128)),
  installed_current_revision: Schema.String.check(Schema.isMaxLength(128)),
  candidate_revision: Schema.String.check(Schema.isMaxLength(128)),
  runtime: Schema.Struct({ harness: Identifier, model: Identifier, config_digest: Sha256 }),
  required_scored_repetitions: Schema.Number,
  max_attempts_per_arm: Schema.Number,
});
export type BlindBenchmarkProtocol = typeof BlindBenchmarkProtocol.Type;

export const BlindBenchmarkAttempt = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("scored"),
    passed: Schema.Boolean,
    executed_revision: Schema.NullOr(Revision),
  }),
  Schema.Struct({ kind: Schema.Literal("infrastructure"), retryable: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
  Schema.Struct({ kind: Schema.Literal("budget_exhausted") }),
]);
export type BlindBenchmarkAttempt = typeof BlindBenchmarkAttempt.Type;

export class BlindBenchmarkExecutionFailure extends Schema.TaggedErrorClass<BlindBenchmarkExecutionFailure>()(
  "BlindBenchmarkExecutionFailure",
  {
    kind: Schema.Literals(["infrastructure", "cancelled", "budget_exhausted"]),
    retryable: Schema.Boolean,
  },
) {}

export interface BlindBenchmarkExecutor {
  readonly execute: (input: {
    readonly case: BlindBenchmarkCase;
    readonly arm: BlindBenchmarkArm;
    readonly revision: string | null;
    readonly repetition: number;
    readonly attempt: number;
    readonly runtime: BlindBenchmarkProtocol["runtime"];
    readonly verifier_id: string;
    readonly verifier_version: string;
  }) => Effect.Effect<BlindBenchmarkAttempt, BlindBenchmarkExecutionFailure>;
}

export const BlindBenchmarkStatus = Schema.Literals(["selected", "inconclusive", "invalid"]);
export const BlindBenchmarkReason = Schema.Literals([
  "selected",
  "unqualified_verifier",
  "invalid_protocol",
  "candidate_generation_leakage",
  "task_fingerprint_mismatch",
  "executor_revision_mismatch",
  "cancelled",
  "budget_exhausted",
  "insufficient_scored_repetitions",
  "no_measurable_headroom",
  "candidate_did_not_beat_baselines",
  "regression_case_failed",
  "audit_holdout_failed",
]);
export const BlindBenchmarkTrial = Schema.Struct({
  case_id: Identifier,
  partition: BlindBenchmarkPartition,
  arm: BlindBenchmarkArm,
  scored_repetitions: Schema.Number,
  censored_attempts: Schema.Number,
  passed_repetitions: Schema.Number,
  skipped: Schema.Boolean,
});
export type BlindBenchmarkTrial = typeof BlindBenchmarkTrial.Type;
export const BlindBenchmarkResult = Schema.Struct({
  manifest_id: Identifier,
  run_id: Identifier,
  status: BlindBenchmarkStatus,
  reason: BlindBenchmarkReason,
  trials: Schema.Array(BlindBenchmarkTrial),
  selection_scores: Schema.Struct({
    no_skill: Schema.Number,
    current_skill: Schema.Number,
    candidate_skill: Schema.Number,
  }),
  audit_opened: Schema.Boolean,
  applies_change: Schema.Literal(false),
});
export type BlindBenchmarkResult = typeof BlindBenchmarkResult.Type;

type ArmRun =
  | { kind: "scored"; passed: boolean; attempts: number; censored: number }
  | { kind: "infra"; attempts: number; censored: number }
  | { kind: "cancelled"; attempts: number; censored: number }
  | { kind: "budget"; attempts: number; censored: number }
  | { kind: "mismatch"; attempts: number; censored: number };
const arms: ReadonlyArray<BlindBenchmarkArm> = ["no_skill", "current_skill", "candidate_skill"];

function id(prefix: string, value: string) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
function fingerprint(text: string) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
function validRevision(value: string) {
  return /^[a-f0-9]{64}$/.test(value);
}

function manifest(protocol: BlindBenchmarkProtocol) {
  return JSON.stringify({
    cases: protocol.cases.toSorted((left, right) => left.case_id.localeCompare(right.case_id)),
    candidate_generation_case_ids: protocol.candidate_generation_case_ids.toSorted(),
    qualified_verifier: protocol.qualified_verifier,
    current_revision: protocol.current_revision,
    installed_current_revision: protocol.installed_current_revision,
    candidate_revision: protocol.candidate_revision,
    runtime: protocol.runtime,
    required_scored_repetitions: protocol.required_scored_repetitions,
    max_attempts_per_arm: protocol.max_attempts_per_arm,
  });
}

function invalid(protocol: BlindBenchmarkProtocol): typeof BlindBenchmarkReason.Type | null {
  const verifier = protocol.qualified_verifier;
  if (
    verifier.status !== "qualified" ||
    verifier.reasons.length !== 1 ||
    verifier.reasons[0] !== "qualified" ||
    verifier.instrument.kind !== "deterministic"
  )
    return "unqualified_verifier";
  if (
    !validRevision(protocol.current_revision) ||
    !validRevision(protocol.candidate_revision) ||
    !validRevision(protocol.installed_current_revision) ||
    protocol.current_revision === protocol.candidate_revision ||
    protocol.installed_current_revision !== protocol.current_revision ||
    !Number.isInteger(protocol.required_scored_repetitions) ||
    protocol.required_scored_repetitions < 3 ||
    protocol.required_scored_repetitions > 32 ||
    !Number.isInteger(protocol.max_attempts_per_arm) ||
    protocol.max_attempts_per_arm < protocol.required_scored_repetitions ||
    protocol.max_attempts_per_arm > 64
  )
    return "invalid_protocol";
  if (protocol.cases.some((entry) => entry.task_fingerprint !== fingerprint(entry.task_payload)))
    return "task_fingerprint_mismatch";
  const caseIds = protocol.cases.map((entry) => entry.case_id);
  if (
    new Set(caseIds).size !== caseIds.length ||
    new Set(protocol.candidate_generation_case_ids).size !==
      protocol.candidate_generation_case_ids.length
  )
    return "invalid_protocol";
  const calibrationIds = new Set(
    protocol.cases
      .filter((entry) => entry.partition === "calibration")
      .map((entry) => entry.case_id),
  );
  if (
    protocol.candidate_generation_case_ids.length === 0 ||
    protocol.candidate_generation_case_ids.some((caseId) => !calibrationIds.has(caseId))
  )
    return "candidate_generation_leakage";
  if (
    calibrationIds.size === 0 ||
    !protocol.cases.some((entry) => entry.partition === "selection") ||
    !protocol.cases.some((entry) => entry.partition === "audit_holdout")
  )
    return "invalid_protocol";
  return null;
}

function terminal(failure: BlindBenchmarkExecutionFailure): BlindBenchmarkAttempt {
  if (failure.kind === "cancelled") return { kind: "cancelled" };
  if (failure.kind === "budget_exhausted") return { kind: "budget_exhausted" };
  return { kind: "infrastructure", retryable: failure.retryable };
}

function runArm(
  protocol: BlindBenchmarkProtocol,
  executor: BlindBenchmarkExecutor,
  entry: BlindBenchmarkCase,
  arm: BlindBenchmarkArm,
  repetition: number,
): Effect.Effect<ArmRun> {
  const revision =
    arm === "no_skill"
      ? null
      : arm === "current_skill"
        ? protocol.current_revision
        : protocol.candidate_revision;
  return Effect.gen(function* () {
    let censored = 0;
    for (let attempt = 1; attempt <= protocol.max_attempts_per_arm; attempt += 1) {
      const outcome = yield* executor
        .execute({
          case: entry,
          arm,
          revision,
          repetition,
          attempt,
          runtime: protocol.runtime,
          verifier_id: protocol.qualified_verifier.instrument.verifier_id,
          verifier_version: protocol.qualified_verifier.instrument.version,
        })
        .pipe(
          Effect.catchTag("BlindBenchmarkExecutionFailure", (failure) =>
            Effect.succeed(terminal(failure)),
          ),
        );
      if (outcome.kind === "scored") {
        if (outcome.executed_revision !== revision)
          return { kind: "mismatch", attempts: attempt, censored };
        return { kind: "scored", passed: outcome.passed, attempts: attempt, censored };
      }
      if (outcome.kind === "cancelled") return { kind: "cancelled", attempts: attempt, censored };
      if (outcome.kind === "budget_exhausted")
        return { kind: "budget", attempts: attempt, censored };
      censored += 1;
      if (!outcome.retryable) return { kind: "infra", attempts: attempt, censored };
    }
    return { kind: "infra", attempts: protocol.max_attempts_per_arm, censored };
  });
}

function emptyResult(
  manifestId: string,
  reason: typeof BlindBenchmarkReason.Type,
): BlindBenchmarkResult {
  return BlindBenchmarkResult.make({
    manifest_id: manifestId,
    run_id: id("blind-benchmark-run", `${manifestId}:${reason}`),
    status: "invalid",
    reason,
    trials: [],
    selection_scores: { no_skill: 0, current_skill: 0, candidate_skill: 0 },
    audit_opened: false,
    applies_change: false,
  });
}

/** Runs only a pre-generated candidate; selection/audit cases never enter candidate generation. */
export function runBlindBenchmark(
  protocol: BlindBenchmarkProtocol,
  executor: BlindBenchmarkExecutor,
): Effect.Effect<BlindBenchmarkResult> {
  return Effect.gen(function* () {
    const manifestId = id("blind-benchmark-manifest", manifest(protocol));
    const invalidReason = invalid(protocol);
    if (invalidReason) return emptyResult(manifestId, invalidReason);
    const trials: BlindBenchmarkTrial[] = [];
    const results = new Map<
      string,
      {
        no_skill: number;
        current_skill: number;
        candidate_skill: number;
        total: number;
        regression: boolean;
      }
    >();
    const runCases = protocol.cases.filter((entry) => entry.partition !== "audit_holdout");
    let auditOpened = false;
    for (const entry of runCases) {
      const row = {
        no_skill: 0,
        current_skill: 0,
        candidate_skill: 0,
        total: protocol.required_scored_repetitions,
        regression: entry.regression_case,
      };
      results.set(entry.case_id, row);
      for (const arm of arms) {
        let passed = 0;
        let censored = 0;
        let scored = 0;
        for (
          let repetition = 1;
          repetition <= protocol.required_scored_repetitions;
          repetition += 1
        ) {
          const outcome = yield* runArm(protocol, executor, entry, arm, repetition);
          censored += outcome.censored;
          if (outcome.kind === "mismatch")
            return BlindBenchmarkResult.make({
              ...emptyResult(manifestId, "executor_revision_mismatch"),
              status: "invalid",
              trials,
              audit_opened: false,
            });
          if (outcome.kind === "cancelled")
            return BlindBenchmarkResult.make({
              ...emptyResult(manifestId, "cancelled"),
              status: "inconclusive",
              trials,
              audit_opened: false,
            });
          if (outcome.kind === "budget")
            return BlindBenchmarkResult.make({
              ...emptyResult(manifestId, "budget_exhausted"),
              status: "inconclusive",
              trials,
              audit_opened: false,
            });
          if (outcome.kind === "infra") {
            trials.push(
              BlindBenchmarkTrial.make({
                case_id: entry.case_id,
                partition: entry.partition,
                arm,
                scored_repetitions: scored,
                censored_attempts: censored,
                passed_repetitions: passed,
                skipped: false,
              }),
            );
            return BlindBenchmarkResult.make({
              ...emptyResult(manifestId, "insufficient_scored_repetitions"),
              status: "inconclusive",
              trials,
              audit_opened: false,
            });
          }
          scored += 1;
          if (outcome.passed) passed += 1;
        }
        row[arm] = passed;
        trials.push(
          BlindBenchmarkTrial.make({
            case_id: entry.case_id,
            partition: entry.partition,
            arm,
            scored_repetitions: scored,
            censored_attempts: censored,
            passed_repetitions: passed,
            skipped: false,
          }),
        );
      }
    }
    const selection = protocol.cases.filter((entry) => entry.partition === "selection");
    const score = (arm: BlindBenchmarkArm) =>
      selection.reduce((total, entry) => total + (results.get(entry.case_id)?.[arm] ?? 0), 0) /
      (selection.length * protocol.required_scored_repetitions);
    const selectionScores = {
      no_skill: score("no_skill"),
      current_skill: score("current_skill"),
      candidate_skill: score("candidate_skill"),
    };
    const regressionFailed = [...results.values()].some(
      (row) => row.regression && row.candidate_skill < row.total,
    );
    const selectionPerCaseRegression = selection.some((entry) => {
      const row = results.get(entry.case_id);
      return (
        row === undefined ||
        row.candidate_skill < row.current_skill ||
        row.candidate_skill < row.no_skill
      );
    });
    const reason = regressionFailed
      ? "regression_case_failed"
      : selectionScores.current_skill >= 1
        ? "no_measurable_headroom"
        : selectionPerCaseRegression ||
            selectionScores.candidate_skill <= selectionScores.current_skill ||
            selectionScores.candidate_skill <= selectionScores.no_skill
          ? "candidate_did_not_beat_baselines"
          : null;
    if (reason)
      return BlindBenchmarkResult.make({
        ...emptyResult(manifestId, reason),
        status: "inconclusive",
        trials,
        selection_scores: selectionScores,
        audit_opened: false,
      });
    auditOpened = true;
    const auditRows = new Map<
      string,
      { no_skill: number; current_skill: number; candidate_skill: number }
    >();
    for (const entry of protocol.cases.filter((item) => item.partition === "audit_holdout")) {
      const auditRow = { no_skill: 0, current_skill: 0, candidate_skill: 0 };
      auditRows.set(entry.case_id, auditRow);
      for (const arm of arms) {
        let passed = 0;
        let censored = 0;
        let scored = 0;
        for (
          let repetition = 1;
          repetition <= protocol.required_scored_repetitions;
          repetition += 1
        ) {
          const outcome = yield* runArm(protocol, executor, entry, arm, repetition);
          censored += outcome.censored;
          if (outcome.kind !== "scored")
            return BlindBenchmarkResult.make({
              ...emptyResult(
                manifestId,
                outcome.kind === "cancelled"
                  ? "cancelled"
                  : outcome.kind === "budget"
                    ? "budget_exhausted"
                    : outcome.kind === "mismatch"
                      ? "executor_revision_mismatch"
                      : "insufficient_scored_repetitions",
              ),
              status: outcome.kind === "mismatch" ? "invalid" : "inconclusive",
              trials,
              selection_scores: selectionScores,
              audit_opened: true,
            });
          scored += 1;
          if (outcome.passed) passed += 1;
        }
        trials.push(
          BlindBenchmarkTrial.make({
            case_id: entry.case_id,
            partition: entry.partition,
            arm,
            scored_repetitions: scored,
            censored_attempts: censored,
            passed_repetitions: passed,
            skipped: false,
          }),
        );
        auditRow[arm] = passed;
      }
    }
    const auditScore = (arm: BlindBenchmarkArm) =>
      [...auditRows.values()].reduce((total, row) => total + row[arm], 0) /
      (auditRows.size * protocol.required_scored_repetitions);
    if (
      [...auditRows.values()].some(
        (row) => row.candidate_skill < row.current_skill || row.candidate_skill < row.no_skill,
      ) ||
      auditScore("candidate_skill") <= auditScore("current_skill") ||
      auditScore("candidate_skill") <= auditScore("no_skill")
    )
      return BlindBenchmarkResult.make({
        ...emptyResult(manifestId, "audit_holdout_failed"),
        status: "inconclusive",
        trials,
        selection_scores: selectionScores,
        audit_opened: true,
      });
    const canonical = JSON.stringify({ manifestId, trials, selectionScores });
    return BlindBenchmarkResult.make({
      manifest_id: manifestId,
      run_id: id("blind-benchmark-run", canonical),
      status: "selected",
      reason: "selected",
      trials,
      selection_scores: selectionScores,
      audit_opened: auditOpened,
      applies_change: false,
    });
  });
}
