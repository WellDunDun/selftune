import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { createOrGetPreparedEvaluationSubmissionDraft } from "@selftune/local-store";
import type { DuckDbAnalyticalStoreService } from "@selftune/observability";
import {
  CohortBodyTeacherOutput,
  type CohortBodyTeacher,
} from "@selftune/runtime/evolution/evidence-cohort-body-adapter";
import { computeNonDominatedFrontier } from "@selftune/runtime/evolution/pareto";
import {
  computeSkillVersionHash,
  type InstalledSkillPackage,
} from "@selftune/runtime/utils/skill-discovery";
import { Effect, Schema } from "effect";

import {
  bodyBelowTitle,
  boundedHistoricalTask,
  byteLength,
  changedLineCount,
  latestPackageMtimeMs,
  pathCanUseInstalledSnapshot,
  redactedPortableText,
} from "./historical-evidence-safety.js";
import { preparedHistoricalTaskDraftSchema } from "./prepared-trace-candidate-draft.js";
import {
  TraceCandidatePreparationError,
  type TraceCandidateReview,
} from "./trace-candidate-contract.js";

function stableTaskRank(value: {
  readonly trace_id: string;
  readonly span_id: string;
  readonly skill_invocation_id: string;
}): string {
  return createHash("sha256")
    .update("selftune.historical-task-quality.v1")
    .update("\u0000")
    .update(value.trace_id)
    .update("\u0000")
    .update(value.span_id)
    .update("\u0000")
    .update(value.skill_invocation_id)
    .digest("hex");
}

type HistoricalInvocationRow = {
  skill_invocation_id: string;
  session_id: string;
  query: string | null;
  matched_prompt: string | null;
  matched_prompt_index: number | null;
  triggered: number | null;
  invocation_mode: string | null;
  source: string | null;
  capture_mode: string | null;
  skill_version_hash: string | null;
  occurred_at: string | null;
  skill_path: string | null;
};

export interface HistoricalTaskCalibrationResult {
  readonly passed: boolean;
  readonly score?: number;
  readonly output: string;
  readonly feedback: string;
  readonly process?: {
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly wall_time_ms: number | null;
  };
}

export type HistoricalTaskCalibrator = (input: {
  readonly task: string;
  readonly body: string;
  readonly arm: "current" | "candidate";
  readonly skillName: string;
  readonly skillPath: string;
}) => Promise<HistoricalTaskCalibrationResult>;

export interface PrepareHistoricalTaskCandidateOptions {
  readonly analytical: DuckDbAnalyticalStoreService;
  readonly sqlite: Database;
  readonly teacher: CohortBodyTeacher;
  readonly patternId: string;
  readonly installed: InstalledSkillPackage;
  readonly skillId: string;
  readonly revision: string;
  readonly computeRevision?: (skillPath: string) => string | undefined;
  readonly candidateCount: number;
  readonly calibrationRepetitions: number;
  readonly calibrator?: HistoricalTaskCalibrator;
}

const CANDIDATE_STRATEGIES = [
  "minimal corrective rule",
  "explicit execution contract",
  "counterexample and failure guardrail",
  "structure-first checklist",
  "concise token-efficient instruction",
  "dependency-ordering emphasis",
  "acceptance-criteria emphasis",
  "direct user-intent emphasis",
] as const;

interface CalibratedHistoricalCandidate {
  readonly proposalId: string;
  readonly teacher: typeof CohortBodyTeacherOutput.Type;
  readonly changedLines: number;
  readonly calibration: HistoricalTaskCalibrationResult;
  readonly calibrationScore: number;
  readonly scoredRepetitions: number;
  readonly passedRepetitions: number;
}

function lowerIsBetter(value: number | null | undefined): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function candidateDominates(
  left: CalibratedHistoricalCandidate,
  right: CalibratedHistoricalCandidate,
): boolean {
  const atLeastAsGood =
    left.calibrationScore >= right.calibrationScore &&
    left.changedLines <= right.changedLines &&
    lowerIsBetter(left.calibration.process?.output_tokens) <=
      lowerIsBetter(right.calibration.process?.output_tokens) &&
    lowerIsBetter(left.calibration.process?.wall_time_ms) <=
      lowerIsBetter(right.calibration.process?.wall_time_ms);
  const strictlyBetter =
    left.calibrationScore > right.calibrationScore ||
    left.changedLines < right.changedLines ||
    lowerIsBetter(left.calibration.process?.output_tokens) <
      lowerIsBetter(right.calibration.process?.output_tokens) ||
    lowerIsBetter(left.calibration.process?.wall_time_ms) <
      lowerIsBetter(right.calibration.process?.wall_time_ms);
  return atLeastAsGood && strictlyBetter;
}

function selectHistoricalCandidate(
  frontier: readonly CalibratedHistoricalCandidate[],
): CalibratedHistoricalCandidate {
  const selected = frontier.toSorted((left, right) => {
    const comparisons = [
      right.calibrationScore - left.calibrationScore,
      left.changedLines - right.changedLines,
      lowerIsBetter(left.calibration.process?.output_tokens) -
        lowerIsBetter(right.calibration.process?.output_tokens),
      lowerIsBetter(left.calibration.process?.input_tokens) -
        lowerIsBetter(right.calibration.process?.input_tokens),
      lowerIsBetter(left.calibration.process?.wall_time_ms) -
        lowerIsBetter(right.calibration.process?.wall_time_ms),
      left.proposalId.localeCompare(right.proposalId),
    ];
    return comparisons.find((comparison) => comparison !== 0) ?? 0;
  })[0];
  if (!selected) throw new Error("Cannot select from an empty historical candidate frontier.");
  return selected;
}

function historicalTaskWithContext(
  sqlite: Database,
  row: HistoricalInvocationRow,
  skillName: string,
): string | null {
  const current =
    boundedHistoricalTask(row.matched_prompt, skillName) ??
    boundedHistoricalTask(row.query, skillName);
  if (!current) return null;
  if (row.matched_prompt_index === null) return current;
  const previous = sqlite
    .query(
      `SELECT prompt_text
       FROM prompts
       WHERE session_id = ? AND prompt_kind = 'user' AND prompt_index < ?
       ORDER BY prompt_index DESC
       LIMIT 8`,
    )
    .all(row.session_id, row.matched_prompt_index) as Array<{ prompt_text: string | null }>;
  const seen = new Set([current]);
  const context = previous
    .flatMap((entry) => {
      const task = boundedHistoricalTask(entry.prompt_text, skillName);
      if (!task || seen.has(task)) return [];
      seen.add(task);
      return [task];
    })
    .slice(0, 2)
    .toReversed();
  if (context.length === 0) return current;
  return boundedHistoricalTask(
    `Current request:\n${current}\n\nEarlier user context:\n${context.join("\n")}`,
    skillName,
  );
}

export const prepareHistoricalTaskCandidate = Effect.fn(
  "TraceCandidatePreparation.prepareHistoricalTaskQuality",
)(function* (options: PrepareHistoricalTaskCandidateOptions) {
  const references = yield* options.analytical
    .queryHistoricalSkillTaskReferences({ skill_id: options.skillId, limit: 512 })
    .pipe(
      Effect.mapError((error) => new TraceCandidatePreparationError({ message: error.message })),
    );
  const ids = references.map((entry) => entry.skill_invocation_id);
  const placeholders = ids.map(() => "?").join(",");
  const rows =
    ids.length === 0
      ? []
      : (options.sqlite
          .query(
            `SELECT
              invocation.skill_invocation_id,
              invocation.session_id,
              invocation.query,
              prompt.prompt_text AS matched_prompt,
              prompt.prompt_index AS matched_prompt_index,
              invocation.triggered,
              invocation.invocation_mode,
              invocation.source,
              invocation.capture_mode,
              invocation.skill_version_hash,
              invocation.occurred_at,
              invocation.skill_path
            FROM skill_invocations invocation
            LEFT JOIN prompts prompt ON prompt.prompt_id = invocation.matched_prompt_id
            WHERE invocation.skill_invocation_id IN (${placeholders})`,
          )
          .all(...ids) as HistoricalInvocationRow[]);
  const packageMtimeMs = yield* Effect.try({
    try: () => latestPackageMtimeMs(options.installed.package_path),
    catch: (error) =>
      new TraceCandidatePreparationError({
        message: `Could not inspect the installed skill snapshot: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
  const rowsById = new Map(rows.map((row) => [row.skill_invocation_id, row]));
  const seenTasks = new Set<string>();
  const tasks = references
    .toSorted((left, right) => stableTaskRank(left).localeCompare(stableTaskRank(right)))
    .flatMap((reference) => {
      const row = rowsById.get(reference.skill_invocation_id);
      if (!row || row.invocation_mode !== "explicit" || !row.triggered) return [];
      if (row.source !== "claude_code_replay" && row.capture_mode !== "hook") return [];
      const occurredAt = row.occurred_at ? Date.parse(row.occurred_at) : Number.NaN;
      const exactRevision =
        row.skill_version_hash === options.revision ||
        (!row.skill_version_hash &&
          Number.isFinite(occurredAt) &&
          packageMtimeMs <= occurredAt &&
          pathCanUseInstalledSnapshot(row.skill_path, options.installed.skill_path));
      if (!exactRevision) return [];
      const task = historicalTaskWithContext(options.sqlite, row, options.installed.name);
      if (!task || seenTasks.has(task)) return [];
      seenTasks.add(task);
      return [{ reference, task }];
    })
    .slice(0, 4);
  if (tasks.length < 3) {
    return {
      draft_id: null,
      pattern_id: options.patternId,
      cohort_fingerprint: null,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason:
        "Historical skill links exist, but fewer than 3 unique explicit tasks resolve to the exact installed revision for separate calibration, selection, and audit partitions.",
      evidence: { cohort_entries: tasks.length, resolved_entries: tasks.length },
      candidate: null,
    } satisfies TraceCandidateReview;
  }
  const selectionIndex = tasks.length - 2;
  const entries = tasks.map(({ reference, task }, index) => ({
    role:
      index < selectionIndex
        ? ("calibration" as const)
        : index === selectionIndex
          ? ("selection" as const)
          : ("audit_holdout" as const),
    source: {
      source_id: reference.source_id,
      source_revision: reference.source_revision,
      trace_id: reference.trace_id,
      span_id: reference.span_id,
      skill_invocation_id: reference.skill_invocation_id,
    },
    redacted_task: task,
  }));
  if (byteLength(JSON.stringify(entries)) > 8_192) {
    return {
      draft_id: null,
      pattern_id: options.patternId,
      cohort_fingerprint: null,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason: "The bounded historical task request exceeds 8 KiB.",
      evidence: { cohort_entries: 0, resolved_entries: 0 },
      candidate: null,
    } satisfies TraceCandidateReview;
  }
  const cohortWithoutFingerprint = {
    schema_version: "1.0.0" as const,
    selector_version: "local-historical-task-quality/v1",
    pattern: {
      pattern_id: options.patternId,
      kind: "historical_task_quality" as const,
      skill_id: options.skillId,
      skill_name: options.installed.name,
    },
    target_skill: {
      skill_id: options.skillId,
      skill_name: options.installed.name,
      revision: options.revision,
    },
    request_limit_bytes: 8_192,
    entries,
  };
  const cohortFingerprint = `sha256:${createHash("sha256")
    .update("selftune.historical-task-quality.cohort.v1")
    .update("\u0000")
    .update(JSON.stringify(cohortWithoutFingerprint))
    .digest("hex")}`;
  const installedContent = yield* Effect.tryPromise({
    try: () => Bun.file(options.installed.skill_path).text(),
    catch: (error) =>
      new TraceCandidatePreparationError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });
  const currentBody = bodyBelowTitle(installedContent);
  const computeRevision = options.computeRevision ?? computeSkillVersionHash;
  if (computeRevision(options.installed.skill_path) !== options.revision) {
    return {
      draft_id: null,
      pattern_id: options.patternId,
      cohort_fingerprint: cohortFingerprint,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason: "The installed skill no longer matches the cohort target revision.",
      evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
      candidate: null,
    } satisfies TraceCandidateReview;
  }
  if (!options.calibrator) {
    return {
      draft_id: null,
      pattern_id: options.patternId,
      cohort_fingerprint: cohortFingerprint,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason:
        "Historical tasks are neutral until the current skill produces a measured calibration failure.",
      evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
      candidate: null,
    } satisfies TraceCandidateReview;
  }
  const calibrationTask = entries.find((entry) => entry.role === "calibration")?.redacted_task;
  if (!calibrationTask) {
    return yield* new TraceCandidatePreparationError({
      message: "The historical task cohort has no calibration partition.",
    });
  }
  const currentCalibrationAttempts = yield* Effect.forEach(
    Array.from({ length: options.calibrationRepetitions }, (_, index) => index + 1),
    () =>
      Effect.tryPromise({
        try: () =>
          options.calibrator?.({
            task: calibrationTask,
            body: currentBody,
            arm: "current",
            skillName: options.installed.name,
            skillPath: options.installed.skill_path,
          }) ?? Promise.reject(new Error("Historical task calibrator is unavailable.")),
        catch: (error) =>
          new TraceCandidatePreparationError({
            message:
              error instanceof Error ? error.message : "Historical calibration replay failed.",
          }),
      }),
    { concurrency: 1 },
  );
  const currentPassedRepetitions = currentCalibrationAttempts.filter(
    (attempt) => attempt.passed,
  ).length;
  if (currentPassedRepetitions === options.calibrationRepetitions) {
    return {
      draft_id: null,
      pattern_id: options.patternId,
      cohort_fingerprint: cohortFingerprint,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason: `The current skill passed ${currentPassedRepetitions}/${options.calibrationRepetitions} calibration repetitions, so there is no measured failure to improve.`,
      evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
      candidate: null,
    } satisfies TraceCandidateReview;
  }
  const currentCalibration = currentCalibrationAttempts.toSorted((left, right) => {
    const leftScore = left.score ?? (left.passed ? 1 : 0);
    const rightScore = right.score ?? (right.passed ? 1 : 0);
    return leftScore - rightScore;
  })[0]!;
  const calibrationExcerpt = redactedPortableText(
    `Current skill passed ${currentPassedRepetitions}/${options.calibrationRepetitions} calibration repetitions.\nDeterministic verifier feedback: ${currentCalibration.feedback}\nCurrent-skill output:\n${currentCalibration.output}`,
  ).slice(0, 2_000);
  const calibrationEvidence = entries
    .filter((entry) => entry.role === "calibration")
    .map((entry) => ({
      reference: `trace://${entry.source.source_id}/${entry.source.source_revision}/${entry.source.trace_id}/${entry.source.span_id}/${entry.source.skill_invocation_id}`,
      query: entry.redacted_task,
      should_trigger: true,
      outcome: "failed" as const,
      excerpt: calibrationExcerpt,
    }));
  const generated = yield* Effect.forEach(
    Array.from({ length: options.candidateCount }, (_, index) => index),
    (index) =>
      Effect.tryPromise({
        try: async () => {
          const teacher = Schema.decodeUnknownSync(CohortBodyTeacherOutput)(
            await options.teacher({
              schema_version: 1,
              cohort_id: cohortFingerprint,
              cohort_fingerprint: cohortFingerprint,
              skill_name: options.installed.name,
              target_revision: options.revision,
              current_body: currentBody,
              calibration: calibrationEvidence,
              search: {
                candidate_index: index + 1,
                candidate_count: options.candidateCount,
                strategy: CANDIDATE_STRATEGIES[index] ?? `bounded strategy ${index + 1}`,
              },
            }),
          );
          const proposedBody = teacher.proposed_body.trim();
          return {
            teacher: { ...teacher, proposed_body: proposedBody },
            changedLines: changedLineCount(currentBody, proposedBody),
          };
        },
        catch: (error) =>
          new TraceCandidatePreparationError({
            message: error instanceof Error ? error.message : "Historical task teacher failed.",
          }),
      }),
    { concurrency: 1 },
  );
  const bounded = generated.filter(
    (entry) =>
      entry.changedLines > 0 &&
      entry.changedLines <= 40 &&
      byteLength(entry.teacher.proposed_body) <= 16_000,
  );
  const unique = [
    ...new Map(bounded.map((entry) => [entry.teacher.proposed_body, entry] as const)).values(),
  ];
  if (computeRevision(options.installed.skill_path) !== options.revision) {
    return {
      draft_id: null,
      pattern_id: options.patternId,
      cohort_fingerprint: cohortFingerprint,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason: "The installed skill changed while candidates were being generated.",
      evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
      candidate: null,
    } satisfies TraceCandidateReview;
  }
  if (unique.length === 0) {
    return {
      draft_id: null,
      pattern_id: options.patternId,
      cohort_fingerprint: cohortFingerprint,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason:
        "Historical candidate search produced no distinct body within the bounded 40-line, 16 KiB mutation contract.",
      evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
      candidate: null,
    } satisfies TraceCandidateReview;
  }
  const calibrated = yield* Effect.forEach(
    unique,
    (entry) =>
      Effect.gen(function* () {
        const proposalId = `evo-body-historical-${createHash("sha256")
          .update(cohortFingerprint)
          .update("\u0000")
          .update(entry.teacher.proposed_body)
          .digest("hex")
          .slice(0, 20)}`;
        const attempts: HistoricalTaskCalibrationResult[] = [];
        for (let repetition = 1; repetition <= options.calibrationRepetitions; repetition += 1) {
          const result = yield* Effect.tryPromise({
            try: () =>
              options.calibrator!({
                task: calibrationTask,
                body: entry.teacher.proposed_body,
                arm: "candidate",
                skillName: options.installed.name,
                skillPath: options.installed.skill_path,
              }),
            catch: (error) =>
              new TraceCandidatePreparationError({
                message:
                  error instanceof Error
                    ? error.message
                    : "Historical candidate calibration failed.",
              }),
          });
          attempts.push(result);
          if (!result.passed) break;
        }
        const passedRepetitions = attempts.filter((attempt) => attempt.passed).length;
        const lastAttempt = attempts.at(-1)!;
        const sumMetric = (
          select: (attempt: HistoricalTaskCalibrationResult) => number | null | undefined,
        ): number | null => {
          const values = attempts.flatMap((attempt) => {
            const value = select(attempt);
            return value == null ? [] : [value];
          });
          return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
        };
        const scores = attempts.map((attempt) => attempt.score ?? (attempt.passed ? 1 : 0));
        const candidateCalibration: HistoricalTaskCalibrationResult = {
          passed: passedRepetitions === options.calibrationRepetitions,
          score: scores.reduce((total, score) => total + score, 0) / scores.length,
          output: lastAttempt.output,
          feedback: lastAttempt.feedback,
          process: {
            input_tokens: sumMetric((attempt) => attempt.process?.input_tokens),
            output_tokens: sumMetric((attempt) => attempt.process?.output_tokens),
            wall_time_ms: sumMetric((attempt) => attempt.process?.wall_time_ms),
          },
        };
        return {
          proposalId,
          teacher: entry.teacher,
          changedLines: entry.changedLines,
          calibration: candidateCalibration,
          calibrationScore: Math.max(0, Math.min(1, candidateCalibration.score ?? 0)),
          scoredRepetitions: attempts.length,
          passedRepetitions,
        } satisfies CalibratedHistoricalCandidate;
      }),
    { concurrency: 1 },
  );
  const eligible = calibrated.filter((entry) => entry.calibration.passed);
  const buildSearchReceipt = (
    frontierIds: readonly string[],
    selectedCandidateId: string | null,
  ) => ({
    requested_candidates: options.candidateCount,
    generated_candidates: unique.length,
    calibrated_candidates: calibrated.length,
    required_calibration_repetitions: options.calibrationRepetitions,
    current_calibration_passed_repetitions: currentPassedRepetitions,
    frontier_candidate_ids: frontierIds,
    selected_candidate_id: selectedCandidateId,
    selection_method: "pareto_calibration_frontier" as const,
    candidate_summaries: calibrated.map((entry) => ({
      proposal_id: entry.proposalId,
      calibration_passed: entry.calibration.passed,
      scored_repetitions: entry.scoredRepetitions,
      passed_repetitions: entry.passedRepetitions,
      calibration_score: entry.calibrationScore,
      changed_lines: entry.changedLines,
      input_tokens: entry.calibration.process?.input_tokens ?? null,
      output_tokens: entry.calibration.process?.output_tokens ?? null,
      wall_time_ms: entry.calibration.process?.wall_time_ms ?? null,
      frontier_member: frontierIds.includes(entry.proposalId),
      selected: entry.proposalId === selectedCandidateId,
    })),
  });
  if (eligible.length === 0) {
    const search = buildSearchReceipt([], null);
    const draftPayload = {
      schema_version: 2 as const,
      cohort: { ...cohortWithoutFingerprint, fingerprint: cohortFingerprint },
      candidate: null,
      search,
    };
    yield* Schema.decodeUnknownEffect(preparedHistoricalTaskDraftSchema)(draftPayload).pipe(
      Effect.mapError((error) => new TraceCandidatePreparationError({ message: error.message })),
    );
    const persistedDraft = yield* createOrGetPreparedEvaluationSubmissionDraft(options.sqlite, {
      draft_id: `eval-draft-${createHash("sha256")
        .update(JSON.stringify(draftPayload))
        .digest("hex")
        .slice(0, 32)}`,
      pattern_id: options.patternId,
      cohort_fingerprint: cohortFingerprint,
      skill_name: options.installed.name,
      skill_revision: options.revision,
      payload_json: JSON.stringify(draftPayload),
    }).pipe(
      Effect.mapError((error) => new TraceCandidatePreparationError({ message: error.message })),
    );
    return {
      draft_id: persistedDraft.draft_id,
      pattern_id: options.patternId,
      cohort_fingerprint: cohortFingerprint,
      target_revision: options.revision,
      readiness: "not_ready",
      failure_reason: `${calibrated.length} bounded candidates were calibrated; none fixed the measured calibration failure.`,
      evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
      candidate: null,
      search,
    } satisfies TraceCandidateReview;
  }
  const frontier = computeNonDominatedFrontier(eligible, candidateDominates);
  const selected = selectHistoricalCandidate(frontier);
  const frontierIds = frontier.map((entry) => entry.proposalId);
  const search = buildSearchReceipt(frontierIds, selected.proposalId);
  const draftPayload = {
    schema_version: 2 as const,
    cohort: { ...cohortWithoutFingerprint, fingerprint: cohortFingerprint },
    candidate: {
      proposal_id: selected.proposalId,
      target_revision: options.revision,
      proposed_body: selected.teacher.proposed_body,
      rationale: selected.teacher.rationale,
    },
    search,
  };
  yield* Schema.decodeUnknownEffect(preparedHistoricalTaskDraftSchema)(draftPayload).pipe(
    Effect.mapError((error) => new TraceCandidatePreparationError({ message: error.message })),
  );
  const persistedDraft = yield* createOrGetPreparedEvaluationSubmissionDraft(options.sqlite, {
    draft_id: `eval-draft-${createHash("sha256")
      .update(JSON.stringify(draftPayload))
      .digest("hex")
      .slice(0, 32)}`,
    pattern_id: options.patternId,
    cohort_fingerprint: cohortFingerprint,
    skill_name: options.installed.name,
    skill_revision: options.revision,
    payload_json: JSON.stringify(draftPayload),
  }).pipe(
    Effect.mapError((error) => new TraceCandidatePreparationError({ message: error.message })),
  );
  return {
    draft_id: persistedDraft.draft_id,
    pattern_id: options.patternId,
    cohort_fingerprint: cohortFingerprint,
    target_revision: options.revision,
    readiness: "review_ready",
    failure_reason: null,
    evidence: { cohort_entries: entries.length, resolved_entries: entries.length },
    candidate: {
      body: selected.teacher.proposed_body,
      rationale: selected.teacher.rationale,
      diff: {
        changed_lines: selected.changedLines,
        target_section: selected.teacher.target_section,
      },
      uncertainty: selected.teacher.uncertainty,
    },
    search,
  } satisfies TraceCandidateReview;
});
