/**
 * One local transaction for trace-backed skill improvement:
 * prepare from DuckDB, freeze a blind protocol, run a harness, and persist a
 * review-only E2 receipt. It never edits or deploys a skill.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import {
  getCorrectionSignalCandidate,
  getEvaluationSubmissionDraft,
  listActivePromotedStudyCases,
  upsertCorrectionSignalCandidate,
} from "@selftune/local-store";
import { replaceBody } from "@selftune/runtime/evolution/deploy-proposal";
import {
  computeSkillVersionHash,
  computeSkillVersionHashWithContent,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";
import {
  BlindBenchmarkCase,
  type BlindBenchmarkExecutor,
  type BlindBenchmarkProtocol,
} from "@selftune/skill-intelligence/blind-benchmark";
import { VerifierQualificationResult } from "@selftune/skill-intelligence/verifier-instruments";
import { Context, Effect, Layer, Schema } from "effect";

import {
  ProactiveExecutionControls,
  makeLocalStoreProactiveCandidateEvaluationPersistence,
  runProactiveCorrectionE2,
} from "./proactive-correction-e2-service.js";
import {
  TraceCandidatePreparation,
  decodePreparedTraceCandidateDraft,
} from "./trace-candidate-service.js";
import type { TraceCandidateReview } from "./trace-candidate-contract.js";
import type {
  HistoricalSkillReplayExecutorFactory,
  HistoricalSkillReplayObservation,
} from "./historical-skill-replay-executor.js";
import { bodyBelowTitle, changedLineCount } from "./historical-evidence-safety.js";

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
);

export const HistoricalSkillImprovementRequest = Schema.Struct({
  pattern_id: Identifier,
  candidate_count: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(2),
      Schema.isLessThanOrEqualTo(8),
    ),
  ),
  qualified_verifier: VerifierQualificationResult,
  runtime: Schema.Struct({
    harness: Identifier,
    model: Identifier,
    config_digest: Sha256,
  }),
  required_scored_repetitions: Schema.Number,
  max_attempts_per_arm: Schema.Number,
  controls: ProactiveExecutionControls,
  recorded_at: Timestamp,
});
export type HistoricalSkillImprovementRequest = typeof HistoricalSkillImprovementRequest.Type;

export interface HistoricalSkillImprovementResponse {
  readonly pattern_id: string;
  readonly draft_id: string | null;
  readonly candidate_id: string | null;
  readonly evaluation_id: string | null;
  readonly status: "review_ready" | "not_ready" | "blocked";
  readonly evidence_level: "E0" | "E0.5" | "E2";
  readonly reason: string;
  readonly cohort_fingerprint: string | null;
  readonly cases: {
    readonly calibration: number;
    readonly selection: number;
    readonly audit_holdout: number;
    readonly active_regressions: number;
  };
  readonly applies_change: false;
  readonly search?: {
    readonly requested_candidates: number;
    readonly generated_candidates: number;
    readonly calibrated_candidates: number;
    readonly required_calibration_repetitions: number;
    readonly current_calibration_passed_repetitions: number;
    readonly frontier_candidate_ids: readonly string[];
    readonly selected_candidate_id: string | null;
    readonly selection_method: "pareto_calibration_frontier";
    readonly candidate_summaries: NonNullable<
      TraceCandidateReview["search"]
    >["candidate_summaries"];
  } | null;
  readonly before_after?: {
    readonly case_id: string;
    readonly task: string;
    readonly current: { readonly passed: boolean; readonly output: string };
    readonly candidate: { readonly passed: boolean; readonly output: string };
  } | null;
}

export class HistoricalSkillImprovementFailure extends Schema.TaggedErrorClass<HistoricalSkillImprovementFailure>()(
  "HistoricalSkillImprovementFailure",
  {
    code: Schema.Literals([
      "INVALID_REQUEST",
      "PREPARATION_FAILED",
      "DRAFT_UNAVAILABLE",
      "STALE_SKILL_REVISION",
      "INVALID_EVIDENCE",
      "INCOMPATIBLE_REGRESSION_VERIFIER",
      "PERSISTENCE_FAILED",
    ]),
    message: Schema.String,
  },
) {}

export interface HistoricalSkillImprovementService {
  readonly evaluate: (
    input: unknown,
  ) => Effect.Effect<HistoricalSkillImprovementResponse, HistoricalSkillImprovementFailure>;
}

export class HistoricalSkillImprovement extends Context.Service<
  HistoricalSkillImprovement,
  HistoricalSkillImprovementService
>()("@selftune/local/HistoricalSkillImprovement") {}

interface RegressionRow {
  readonly case_id: string;
  readonly manifest_json: string;
  readonly verifier_payload_json: string;
}

interface RegressionProjection {
  readonly benchmarkCase: typeof BlindBenchmarkCase.Type;
  readonly activeCase: {
    readonly case_id: string;
    readonly skill_id: string;
    readonly status: "active";
    readonly task_fingerprint: string;
  };
}

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const stableId = (prefix: string, value: string): string =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

const skillId = (name: string): string =>
  `skill-${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;

function sourceKey(value: {
  readonly source_id: string;
  readonly source_revision: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly skill_invocation_id: string;
}): string {
  return [
    value.source_id,
    value.source_revision,
    value.trace_id,
    value.span_id,
    value.skill_invocation_id,
  ].join("\u0000");
}

function caseId(role: string, source: { readonly skill_invocation_id: string }): string {
  return stableId("historical-case", `${role}\u0000${source.skill_invocation_id}`);
}

function parseJson(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`${label} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new HistoricalSkillImprovementFailure({
      code: "INVALID_EVIDENCE",
      message: `${label} could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function regressionProjection(
  row: RegressionRow,
  expectedVerifier: typeof VerifierQualificationResult.Type,
  owningSkillId: string,
): RegressionProjection {
  const verifier = parseJson(row.verifier_payload_json, `Verifier for ${row.case_id}`);
  const instrument = nestedRecord(verifier.instrument);
  if (
    instrument?.verifier_id !== expectedVerifier.instrument.verifier_id ||
    instrument.version !== expectedVerifier.instrument.version
  ) {
    throw new HistoricalSkillImprovementFailure({
      code: "INCOMPATIBLE_REGRESSION_VERIFIER",
      message: `Active regression ${row.case_id} requires a different verifier.`,
    });
  }
  const manifest = parseJson(row.manifest_json, `Manifest for ${row.case_id}`);
  const taskCase = nestedRecord(manifest.task_case);
  const episode = nestedRecord(manifest.episode);
  const taskPayload =
    typeof taskCase?.task_payload === "string"
      ? taskCase.task_payload
      : typeof episode?.task === "string"
        ? episode.task
        : null;
  if (!taskPayload || taskPayload.length > 8_000) {
    throw new HistoricalSkillImprovementFailure({
      code: "INVALID_EVIDENCE",
      message: `Active regression ${row.case_id} has no bounded replay task.`,
    });
  }
  const taskFingerprint =
    typeof taskCase?.task_fingerprint === "string"
      ? taskCase.task_fingerprint
      : digest(taskPayload);
  const benchmarkCase = BlindBenchmarkCase.make({
    case_id: row.case_id,
    task_payload: taskPayload,
    task_fingerprint: taskFingerprint,
    partition: "selection",
    regression_case: true,
  });
  return {
    benchmarkCase,
    activeCase: {
      case_id: row.case_id,
      skill_id: owningSkillId,
      status: "active",
      task_fingerprint: benchmarkCase.task_fingerprint,
    },
  };
}

function emptyCounts() {
  return { calibration: 0, selection: 0, audit_holdout: 0, active_regressions: 0 };
}

function historicalFailure(
  error: unknown,
  code: HistoricalSkillImprovementFailure["code"] = "INVALID_EVIDENCE",
): HistoricalSkillImprovementFailure {
  return error instanceof HistoricalSkillImprovementFailure
    ? error
    : new HistoricalSkillImprovementFailure({
        code,
        message: error instanceof Error ? error.message : String(error),
      });
}

function boundedReplayOutput(value: string, limitBytes: number = 4_000): string {
  const redacted = value
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:~|\/Users\/[^\s/]+|\/home\/[^\s/]+)(?:\/[^\s]*)?/g, "[local-path]");
  const encoder = new TextEncoder();
  let output = "";
  for (const character of redacted) {
    if (encoder.encode(`${output}${character}`).byteLength > limitBytes) break;
    output += character;
  }
  return output;
}

export function makeHistoricalSkillImprovementLayer(options: {
  readonly sqlite: Database;
  readonly executor?: BlindBenchmarkExecutor;
  readonly executorFactory?: HistoricalSkillReplayExecutorFactory;
  readonly searchDirs?: readonly string[];
}): Layer.Layer<HistoricalSkillImprovement, never, TraceCandidatePreparation> {
  return Layer.effect(
    HistoricalSkillImprovement,
    Effect.gen(function* () {
      const preparation = yield* TraceCandidatePreparation;
      const evaluate = Effect.fn("HistoricalSkillImprovement.evaluate")(function* (
        unknownInput: unknown,
      ) {
        const input = yield* Schema.decodeUnknownEffect(HistoricalSkillImprovementRequest)(
          unknownInput,
        ).pipe(
          Effect.mapError(
            (error) =>
              new HistoricalSkillImprovementFailure({
                code: "INVALID_REQUEST",
                message: error.message,
              }),
          ),
        );
        const review = yield* preparation
          .prepare({
            pattern_id: input.pattern_id,
            candidate_count: input.candidate_count ?? 3,
            calibration_repetitions: input.required_scored_repetitions,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new HistoricalSkillImprovementFailure({
                  code: "PREPARATION_FAILED",
                  message: error.message,
                }),
            ),
          );
        if (review.readiness !== "review_ready" || !review.draft_id) {
          return {
            pattern_id: input.pattern_id,
            draft_id: review.draft_id,
            candidate_id: null,
            evaluation_id: null,
            status: "not_ready",
            evidence_level: "E0",
            reason: review.failure_reason ?? "Historical evidence is not ready for evaluation.",
            cohort_fingerprint: review.cohort_fingerprint,
            cases: emptyCounts(),
            applies_change: false,
            search: review.search ?? null,
          } satisfies HistoricalSkillImprovementResponse;
        }

        const storedDraft = yield* getEvaluationSubmissionDraft(
          options.sqlite,
          review.draft_id,
        ).pipe(
          Effect.mapError(
            (error) =>
              new HistoricalSkillImprovementFailure({
                code: "PERSISTENCE_FAILED",
                message: error.message,
              }),
          ),
        );
        if (!storedDraft || storedDraft.lifecycle !== "prepared") {
          return yield* new HistoricalSkillImprovementFailure({
            code: "DRAFT_UNAVAILABLE",
            message: "The prepared historical candidate is no longer available.",
          });
        }
        const rawDraft = yield* Effect.try({
          try: () => JSON.parse(storedDraft.payload_json),
          catch: (error) => historicalFailure(error),
        });
        const draft = yield* decodePreparedTraceCandidateDraft(rawDraft).pipe(
          Effect.mapError(
            (error) =>
              new HistoricalSkillImprovementFailure({
                code: "INVALID_EVIDENCE",
                message: error.message,
              }),
          ),
        );
        if (draft.candidate === null) {
          return yield* new HistoricalSkillImprovementFailure({
            code: "DRAFT_UNAVAILABLE",
            message: "The historical search receipt does not contain a selected candidate.",
          });
        }
        const installed = findInstalledSkillPackages([
          ...(options.searchDirs ?? getDefaultSkillSearchDirs()),
        ]).find((skill) => skill.name === storedDraft.skill_name);
        if (!installed) {
          return yield* new HistoricalSkillImprovementFailure({
            code: "DRAFT_UNAVAILABLE",
            message: "The target skill is no longer installed.",
          });
        }
        const installedRevision = computeSkillVersionHash(installed.skill_path);
        if (
          !installedRevision ||
          installedRevision !== storedDraft.skill_revision ||
          installedRevision !== draft.candidate.target_revision
        ) {
          return yield* new HistoricalSkillImprovementFailure({
            code: "STALE_SKILL_REVISION",
            message: "The installed skill changed after historical evidence was frozen.",
          });
        }
        const installedContent = yield* Effect.tryPromise({
          try: () => Bun.file(installed.skill_path).text(),
          catch: (error) =>
            new HistoricalSkillImprovementFailure({
              code: "DRAFT_UNAVAILABLE",
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        const installedBody = bodyBelowTitle(installedContent);
        const candidateContent = replaceBody(installedContent, draft.candidate.proposed_body);
        const candidateRevision = computeSkillVersionHashWithContent(
          installed.skill_path,
          candidateContent,
        );
        if (!candidateRevision || candidateRevision === installedRevision) {
          return yield* new HistoricalSkillImprovementFailure({
            code: "INVALID_EVIDENCE",
            message:
              "The proposed body does not produce a distinct, reproducible package revision.",
          });
        }

        const historicalCases = yield* Effect.try({
          try: () => {
            if (draft.schema_version === 2) {
              return draft.cohort.entries.map((entry) =>
                BlindBenchmarkCase.make({
                  case_id: caseId(entry.role, entry.source),
                  task_payload: entry.redacted_task,
                  task_fingerprint: digest(entry.redacted_task),
                  partition: entry.role,
                  regression_case: false,
                }),
              );
            }
            const resolved = new Map(
              draft.resolved_evidence.map((entry) => [sourceKey(entry), entry]),
            );
            return draft.cohort.entries.flatMap((entry) => {
              const evidence = resolved.get(sourceKey(entry.source));
              if (!evidence) return [];
              if (!evidence.query.trim() || evidence.query.length > 8_000) {
                throw new HistoricalSkillImprovementFailure({
                  code: "INVALID_EVIDENCE",
                  message: `Historical case ${entry.source.skill_invocation_id} has no bounded task.`,
                });
              }
              const partition =
                entry.role === "heldout_failure"
                  ? "selection"
                  : entry.role === "heldout_success"
                    ? "audit_holdout"
                    : "calibration";
              return [
                BlindBenchmarkCase.make({
                  case_id: caseId(entry.role, entry.source),
                  task_payload: evidence.query,
                  task_fingerprint: digest(evidence.query),
                  partition,
                  regression_case: false,
                }),
              ];
            });
          },
          catch: (error) => historicalFailure(error),
        });
        const owningSkillId = skillId(draft.cohort.target_skill.skill_name);
        const regressionRows = yield* Effect.try({
          try: () =>
            listActivePromotedStudyCases(options.sqlite, owningSkillId, 50) as RegressionRow[],
          catch: (error) =>
            new HistoricalSkillImprovementFailure({
              code: "PERSISTENCE_FAILED",
              message: error instanceof Error ? error.message : String(error),
            }),
        });
        const regressions = yield* Effect.try({
          try: () =>
            regressionRows.map((row) =>
              regressionProjection(row, input.qualified_verifier, owningSkillId),
            ),
          catch: (error) => historicalFailure(error),
        });
        const cases = [...historicalCases, ...regressions.map((entry) => entry.benchmarkCase)];
        const protocol: BlindBenchmarkProtocol = {
          cases,
          candidate_generation_case_ids: historicalCases
            .filter((entry) => entry.partition === "calibration")
            .map((entry) => entry.case_id),
          qualified_verifier: input.qualified_verifier,
          current_revision: installedRevision,
          installed_current_revision: installedRevision,
          candidate_revision: candidateRevision,
          runtime: input.runtime,
          required_scored_repetitions: input.required_scored_repetitions,
          max_attempts_per_arm: input.max_attempts_per_arm,
        };
        const replayObservations: HistoricalSkillReplayObservation[] = [];
        const executor = options.executorFactory
          ? yield* options.executorFactory
              .create({
                skillName: draft.cohort.target_skill.skill_name,
                skillPath: installed.skill_path,
                currentBody: installedBody,
                candidateBody: draft.candidate.proposed_body,
                currentRevision: installedRevision,
                candidateRevision,
                runtime: input.runtime,
                qualifiedVerifier: input.qualified_verifier,
                recordObservation: (observation) => replayObservations.push(observation),
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new HistoricalSkillImprovementFailure({
                      code: "INVALID_EVIDENCE",
                      message: error.message,
                    }),
                ),
              )
          : options.executor;
        if (!executor) {
          return yield* new HistoricalSkillImprovementFailure({
            code: "INVALID_EVIDENCE",
            message: "No managed replay harness is registered for historical evaluation.",
          });
        }
        const candidateId = review.draft_id;
        const taskQuality = draft.schema_version === 2;
        const sourceSessionId =
          (taskQuality
            ? draft.cohort.entries.find((entry) => entry.role === "selection")?.source.trace_id
            : draft.cohort.entries.find((entry) => entry.role === "heldout_failure")?.source
                .trace_id) ??
          draft.cohort.entries[0]?.source.trace_id ??
          input.pattern_id;
        const hypothesisReason = taskQuality
          ? "Neutral historical tasks produced a bounded skill-body hypothesis for randomized execution-quality replay."
          : "Repeated trace-correlated errors produced a bounded skill-body hypothesis.";
        const signalPayload = JSON.stringify({
          kind: taskQuality ? "historical_task_quality" : "repeated_correlated_errors",
          pattern_id: input.pattern_id,
          cohort_fingerprint: draft.cohort.fingerprint,
          candidate_id: candidateId,
          evidence_level: "E0",
          reason: hypothesisReason,
          skill: {
            name: draft.cohort.target_skill.skill_name,
            pre_revision: installedRevision,
            post_revision: null,
          },
          source: {
            session_id: sourceSessionId,
          },
          correction_intent: draft.candidate.rationale,
        });
        const existingCandidate = yield* getCorrectionSignalCandidate(
          options.sqlite,
          candidateId,
        ).pipe(
          Effect.mapError(
            (error) =>
              new HistoricalSkillImprovementFailure({
                code: "PERSISTENCE_FAILED",
                message: error.message,
              }),
          ),
        );
        yield* upsertCorrectionSignalCandidate(options.sqlite, {
          candidate_id: candidateId,
          idempotency_key: `historical-improvement:${candidateId}`,
          skill_id: owningSkillId,
          skill_name: draft.cohort.target_skill.skill_name,
          source_session_id: sourceSessionId,
          evidence_level: "E0",
          lifecycle: "review_ready",
          reason: hypothesisReason,
          manifest_digest: digest(
            JSON.stringify({
              draft_id: review.draft_id,
              cohort_fingerprint: draft.cohort.fingerprint,
              candidate_revision: candidateRevision,
            }),
          ),
          signal_payload_digest: digest(signalPayload),
          signal_payload_json: signalPayload,
          created_at: existingCandidate?.created_at ?? input.recorded_at,
          updated_at: input.recorded_at,
        }).pipe(
          Effect.mapError(
            (error) =>
              new HistoricalSkillImprovementFailure({
                code: "PERSISTENCE_FAILED",
                message: error.message,
              }),
          ),
        );
        const evaluation = yield* runProactiveCorrectionE2(
          {
            candidate: {
              candidate_id: candidateId,
              skill_id: owningSkillId,
              skill_name: draft.cohort.target_skill.skill_name,
              candidate_kind: "existing_skill_body_mutation",
              installed_body: installedBody,
              proposed_body: draft.candidate.proposed_body,
              installed_revision: installedRevision,
              candidate_revision: candidateRevision,
              changed_lines: changedLineCount(installedBody, draft.candidate.proposed_body),
              cross_file_edits: false,
              protected_metadata_changed: false,
            },
            observed_installed_revision: installedRevision,
            protocol,
            active_regression_cases: regressions.map((entry) => entry.activeCase),
            controls: input.controls,
            recorded_at: input.recorded_at,
          },
          executor,
          makeLocalStoreProactiveCandidateEvaluationPersistence(options.sqlite),
        ).pipe(
          Effect.mapError(
            (error) =>
              new HistoricalSkillImprovementFailure({
                code:
                  error.code === "PERSISTENCE_FAILED" ? "PERSISTENCE_FAILED" : "INVALID_EVIDENCE",
                message: error.message,
              }),
          ),
        );
        const selectionCase = historicalCases.find(
          (entry) => entry.partition === "selection" && !entry.regression_case,
        );
        const currentObservation = selectionCase
          ? replayObservations.find(
              (entry) => entry.caseId === selectionCase.case_id && entry.arm === "current_skill",
            )
          : undefined;
        const candidateObservation = selectionCase
          ? replayObservations.find(
              (entry) => entry.caseId === selectionCase.case_id && entry.arm === "candidate_skill",
            )
          : undefined;
        const beforeAfter =
          selectionCase && currentObservation && candidateObservation
            ? {
                case_id: selectionCase.case_id,
                task: selectionCase.task_payload,
                current: {
                  passed: currentObservation.passed,
                  output: boundedReplayOutput(currentObservation.output),
                },
                candidate: {
                  passed: candidateObservation.passed,
                  output: boundedReplayOutput(candidateObservation.output),
                },
              }
            : null;
        return {
          pattern_id: input.pattern_id,
          draft_id: review.draft_id,
          candidate_id: candidateId,
          evaluation_id: evaluation.evaluation_id,
          status: evaluation.status,
          evidence_level: evaluation.evidence_level,
          reason: evaluation.reason,
          cohort_fingerprint: draft.cohort.fingerprint,
          cases: {
            calibration: cases.filter((entry) => entry.partition === "calibration").length,
            selection: cases.filter((entry) => entry.partition === "selection").length,
            audit_holdout: cases.filter((entry) => entry.partition === "audit_holdout").length,
            active_regressions: regressions.length,
          },
          applies_change: false,
          search: draft.schema_version === 2 ? (draft.search ?? null) : null,
          before_after: beforeAfter,
        } satisfies HistoricalSkillImprovementResponse;
      });
      return HistoricalSkillImprovement.of({ evaluate });
    }),
  );
}
