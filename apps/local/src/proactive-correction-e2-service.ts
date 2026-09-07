import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import {
  BlindBenchmarkProtocol,
  type BlindBenchmarkExecutor,
  type BlindBenchmarkResult,
  runBlindBenchmark,
} from "@selftune/skill-intelligence/blind-benchmark";
import { createOrGetCorrectionCandidateEvaluation } from "@selftune/local-store";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { changedLineCount } from "./historical-evidence-safety.js";

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const BoundedBody = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_000));
const Timestamp = Schema.String.check(Schema.isMaxLength(64));

export const ProactiveExistingSkillBodyCandidate = Schema.Struct({
  candidate_id: Identifier,
  skill_id: Identifier,
  skill_name: Identifier,
  candidate_kind: Schema.Literal("existing_skill_body_mutation"),
  installed_body: BoundedBody,
  proposed_body: BoundedBody,
  installed_revision: Revision,
  candidate_revision: Revision,
  changed_lines: Schema.Number,
  cross_file_edits: Schema.Literal(false),
  protected_metadata_changed: Schema.Literal(false),
});
export type ProactiveExistingSkillBodyCandidate = typeof ProactiveExistingSkillBodyCandidate.Type;

export const ActiveRegressionCase = Schema.Struct({
  case_id: Identifier,
  skill_id: Identifier,
  status: Schema.Literal("active"),
  task_fingerprint: Sha256,
});
export type ActiveRegressionCase = typeof ActiveRegressionCase.Type;

export const ProactiveExecutionControls = Schema.Struct({
  entitlement_proactive_managed: Schema.Boolean,
  proactive_generation_enabled: Schema.Boolean,
  managed_execution_enabled: Schema.Boolean,
  kill_switch_enabled: Schema.Boolean,
  active_runs: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  max_concurrency: Schema.Number.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(32),
  ),
  budget_remaining_usd: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  estimated_cost_usd: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export type ProactiveExecutionControls = typeof ProactiveExecutionControls.Type;

export const ProactiveCorrectionE2Request = Schema.Struct({
  candidate: ProactiveExistingSkillBodyCandidate,
  observed_installed_revision: Revision,
  protocol: BlindBenchmarkProtocol,
  active_regression_cases: Schema.Array(ActiveRegressionCase).check(Schema.isMaxLength(64)),
  controls: ProactiveExecutionControls,
  recorded_at: Timestamp,
});
export type ProactiveCorrectionE2Request = typeof ProactiveCorrectionE2Request.Type;

export const ProactiveCorrectionE2Status = Schema.Literals([
  "review_ready",
  "not_ready",
  "blocked",
]);
export type ProactiveCorrectionE2Status = typeof ProactiveCorrectionE2Status.Type;

export interface ProactiveCandidateEvaluationRecord {
  readonly evaluation_id: string;
  readonly candidate_id: string;
  readonly skill_id: string;
  readonly current_revision: string;
  readonly candidate_revision: string;
  readonly verifier_provenance_json: string;
  readonly runtime_provenance_json: string;
  readonly cost_estimate_json: string;
  readonly cost_estimate_decimal: string;
  readonly manifest_id: string | null;
  readonly evidence_level: "E0.5" | "E2";
  readonly status: ProactiveCorrectionE2Status;
  readonly reason: string;
  readonly immutable_manifest_json: string;
  readonly benchmark_result_json: string | null;
  readonly recorded_at: string;
  readonly applies_change: false;
}

export class ProactiveCandidateEvaluationPersistenceFailure extends Schema.TaggedErrorClass<ProactiveCandidateEvaluationPersistenceFailure>()(
  "ProactiveCandidateEvaluationPersistenceFailure",
  { message: Schema.String },
) {}

/** The local-store owner wires its immutable table API behind this seam. */
export interface ProactiveCandidateEvaluationPersistence {
  readonly persist: (
    record: ProactiveCandidateEvaluationRecord,
  ) => Effect.Effect<
    ProactiveCandidateEvaluationRecord,
    ProactiveCandidateEvaluationPersistenceFailure
  >;
}

export class ProactiveEvaluationPersistence extends Context.Service<
  ProactiveEvaluationPersistence,
  ProactiveCandidateEvaluationPersistence
>()("SelfTune/ProactiveEvaluationPersistence") {}

export function makeLocalStoreProactiveEvaluationLayer(database: Database) {
  return Layer.sync(ProactiveEvaluationPersistence)(() =>
    makeLocalStoreProactiveCandidateEvaluationPersistence(database),
  );
}

/**
 * Adapter for the append-only local-store API. The database table keeps its
 * lifecycle vocabulary intentionally small; blocked requests are immutable
 * invalid receipts, while the public response retains the clearer `blocked`.
 */
export function makeLocalStoreProactiveCandidateEvaluationPersistence(
  database: Database,
): ProactiveCandidateEvaluationPersistence {
  return {
    persist: (entry) =>
      Effect.try({
        try: () => {
          createOrGetCorrectionCandidateEvaluation(database, {
            evaluation_id: entry.evaluation_id,
            candidate_id: entry.candidate_id,
            current_revision: entry.current_revision,
            candidate_revision: entry.candidate_revision,
            evidence_level: entry.evidence_level,
            status:
              entry.status === "review_ready"
                ? "selected"
                : entry.reason.startsWith("invalid_") || entry.status === "blocked"
                  ? "invalid"
                  : "inconclusive",
            reason: entry.reason,
            blind_manifest_json: entry.immutable_manifest_json,
            blind_result_json:
              entry.benchmark_result_json ?? JSON.stringify({ applies_change: false }),
            verifier_provenance: entry.verifier_provenance_json,
            runtime_provenance: entry.runtime_provenance_json,
            cost_estimate: entry.cost_estimate_decimal,
            recorded_at: entry.recorded_at,
          });
          return entry;
        },
        catch: (cause) =>
          new ProactiveCandidateEvaluationPersistenceFailure({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
  };
}

export class ProactiveCorrectionE2Failure extends Schema.TaggedErrorClass<ProactiveCorrectionE2Failure>()(
  "ProactiveCorrectionE2Failure",
  { code: Schema.Literals(["INVALID_REQUEST", "PERSISTENCE_FAILED"]), message: Schema.String },
) {}

export interface ProactiveCorrectionE2Response {
  readonly evaluation_id: string;
  readonly status: ProactiveCorrectionE2Status;
  readonly evidence_level: "E0.5" | "E2";
  readonly reason: string;
  readonly manifest_id: string | null;
  readonly applies_change: false;
}

function stableId(prefix: string, canonical: string): string {
  return `${prefix}-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function candidateReason(candidate: ProactiveExistingSkillBodyCandidate): string | null {
  if (candidate.candidate_revision === candidate.installed_revision)
    return "candidate_revision_not_distinct";
  if (candidate.proposed_body === candidate.installed_body) return "empty_body_mutation";
  if (candidate.cross_file_edits || candidate.protected_metadata_changed)
    return "protected_mutation_surface";
  if (candidate.proposed_body.startsWith("---")) return "protected_metadata_changed";
  if (
    !Number.isInteger(candidate.changed_lines) ||
    candidate.changed_lines < 1 ||
    candidate.changed_lines > 40 ||
    changedLineCount(candidate.installed_body, candidate.proposed_body) !== candidate.changed_lines
  )
    return "invalid_changed_line_bound";
  return null;
}

function controlReason(controls: ProactiveExecutionControls): string | null {
  if (!controls.entitlement_proactive_managed) return "entitlement_required";
  if (!controls.proactive_generation_enabled) return "proactive_policy_disabled";
  if (!controls.managed_execution_enabled) return "managed_execution_disabled";
  if (controls.kill_switch_enabled) return "kill_switch_enabled";
  if (controls.active_runs >= controls.max_concurrency) return "concurrency_limit_reached";
  if (controls.estimated_cost_usd > controls.budget_remaining_usd) return "budget_insufficient";
  return null;
}

function regressionReason(input: ProactiveCorrectionE2Request): string | null {
  const applicable = input.active_regression_cases.filter(
    (entry) => entry.skill_id === input.candidate.skill_id,
  );
  const protocolCases = new Map(input.protocol.cases.map((entry) => [entry.case_id, entry]));
  if (new Set(applicable.map((entry) => entry.case_id)).size !== applicable.length)
    return "duplicate_active_regression_case";
  if (
    applicable.some((entry) => {
      const benchmarkCase = protocolCases.get(entry.case_id);
      return (
        benchmarkCase === undefined ||
        !benchmarkCase.regression_case ||
        benchmarkCase.task_fingerprint !== entry.task_fingerprint
      );
    })
  )
    return "missing_or_unflagged_regression_case";
  return null;
}

function record(
  input: ProactiveCorrectionE2Request,
  status: ProactiveCorrectionE2Status,
  reason: string,
  benchmark: BlindBenchmarkResult | null,
): ProactiveCandidateEvaluationRecord {
  const immutableManifest = JSON.stringify({
    candidate: input.candidate,
    observed_installed_revision: input.observed_installed_revision,
    protocol: input.protocol,
    active_regression_cases: input.active_regression_cases,
    controls: input.controls,
  });
  return {
    evaluation_id: stableId(
      "proactive-e2-evaluation",
      JSON.stringify({ immutableManifest, status, reason, benchmark }),
    ),
    candidate_id: input.candidate.candidate_id,
    skill_id: input.candidate.skill_id,
    current_revision: input.candidate.installed_revision,
    candidate_revision: input.candidate.candidate_revision,
    verifier_provenance_json: JSON.stringify(input.protocol.qualified_verifier),
    runtime_provenance_json: JSON.stringify(input.protocol.runtime),
    cost_estimate_json: JSON.stringify({ estimated_cost_usd: input.controls.estimated_cost_usd }),
    cost_estimate_decimal: input.controls.estimated_cost_usd.toFixed(6).replace(/\.0+$/, ""),
    manifest_id: benchmark?.manifest_id ?? null,
    evidence_level: status === "review_ready" ? "E2" : "E0.5",
    status,
    reason,
    immutable_manifest_json: immutableManifest,
    benchmark_result_json: benchmark === null ? null : JSON.stringify(benchmark),
    recorded_at: input.recorded_at,
    applies_change: false,
  };
}

export const runProactiveCorrectionE2 = Effect.fn("ProactiveCorrectionE2.run")(function* (
  request: ProactiveCorrectionE2Request,
  executor: BlindBenchmarkExecutor,
  persistence: ProactiveCandidateEvaluationPersistence,
) {
  const input = yield* Schema.decodeUnknownEffect(ProactiveCorrectionE2Request)(request).pipe(
    Effect.mapError(
      (error) =>
        new ProactiveCorrectionE2Failure({ code: "INVALID_REQUEST", message: error.message }),
    ),
  );
  const refusal =
    controlReason(input.controls) ??
    (input.observed_installed_revision !== input.candidate.installed_revision
      ? "stale_installed_revision"
      : null) ??
    candidateReason(input.candidate) ??
    (input.protocol.current_revision !== input.candidate.installed_revision ||
    input.protocol.installed_current_revision !== input.observed_installed_revision ||
    input.protocol.candidate_revision !== input.candidate.candidate_revision
      ? "revision_pin_mismatch"
      : null) ??
    regressionReason(input);
  const benchmark = refusal === null ? yield* runBlindBenchmark(input.protocol, executor) : null;
  const status: ProactiveCorrectionE2Status =
    refusal !== null ? "blocked" : benchmark?.status === "selected" ? "review_ready" : "not_ready";
  const persisted = yield* persistence
    .persist(record(input, status, refusal ?? benchmark?.reason ?? "benchmark_not_run", benchmark))
    .pipe(
      Effect.mapError(
        (error) =>
          new ProactiveCorrectionE2Failure({ code: "PERSISTENCE_FAILED", message: error.message }),
      ),
    );
  return {
    evaluation_id: persisted.evaluation_id,
    status: persisted.status,
    evidence_level: persisted.evidence_level,
    reason: persisted.reason,
    manifest_id: persisted.manifest_id,
    applies_change: false,
  } satisfies ProactiveCorrectionE2Response;
});
