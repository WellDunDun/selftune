/** Local-only preparation of a review candidate from a supported trace pattern. */
import { Effect, Layer, Schema } from "effect";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createOrGetPreparedEvaluationSubmissionDraft } from "@selftune/local-store";

import { DuckDbAnalyticalStore, materializeEvidenceCohort } from "@selftune/observability";
import {
  ResolvedEvidenceReference,
  evolveBodyFromEvidenceCohort,
  type CohortBodyEvolutionDeps,
  type CohortBodyTeacher,
} from "@selftune/runtime/evolution/evidence-cohort-body-adapter";
import { callViaSubagent, type LlmBackedAgent } from "@selftune/runtime/utils/llm-call";
import {
  computeSkillVersionHash,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";
import {
  boundedHistoricalTask,
  latestPackageMtimeMs,
  pathCanUseInstalledSnapshot,
  redactedPortableText,
} from "./historical-evidence-safety.js";
import {
  prepareHistoricalTaskCandidate,
  type HistoricalTaskCalibrator,
} from "./historical-task-candidate.js";
import {
  TraceCandidatePreparation,
  TraceCandidatePreparationError,
  type TraceCandidateReview,
} from "./trace-candidate-contract.js";

export { boundedHistoricalTask } from "./historical-evidence-safety.js";
export { decodePreparedTraceCandidateDraft } from "./prepared-trace-candidate-draft.js";
export { TraceCandidatePreparation } from "./trace-candidate-contract.js";

function taskMentionsSkill(task: string, skillName: string): boolean {
  const normalizedTask = task.toLowerCase();
  const normalizedSkill = skillName.trim().toLowerCase();
  return normalizedTask.includes(normalizedSkill) || normalizedTask.includes(`/${normalizedSkill}`);
}

const requestSchema = Schema.Struct({
  pattern_id: Schema.String.check(Schema.isNonEmpty()),
  candidate_count: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(2),
      Schema.isLessThanOrEqualTo(8),
    ),
  ),
  calibration_repetitions: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(5),
    ),
  ),
});
export type TraceCandidateRequest = typeof requestSchema.Type;

const supportedPatternThreshold = {
  uniqueTraces: 3,
  errorTraces: 2,
  successTraces: 1,
} as const;

export function supportsContrastiveRepeatedErrorPattern(input: {
  readonly uniqueTraceCount: number;
  readonly errorTraceCount: number;
}): boolean {
  const successTraceCount = input.uniqueTraceCount - input.errorTraceCount;
  return (
    input.uniqueTraceCount >= supportedPatternThreshold.uniqueTraces &&
    input.errorTraceCount >= supportedPatternThreshold.errorTraces &&
    successTraceCount >= supportedPatternThreshold.successTraces
  );
}

export function executionPatternIdForSkill(skillName: string): string {
  const id = skillName.trim().toLowerCase();
  const digest = createHash("sha256")
    .update(`repeated_correlated_errors:${id}`)
    .digest("hex")
    .slice(0, 16);
  return `execution-pattern-${digest}`;
}

function matchingInstalledSkill(patternId: string, searchDirs: readonly string[]) {
  return findInstalledSkillPackages([...searchDirs]).find((skill) => {
    return patternId === executionPatternIdForSkill(skill.name);
  });
}

export function makeLiveCohortBodyTeacher(options?: {
  readonly agent?: LlmBackedAgent;
}): CohortBodyTeacher {
  return async (input) => {
    const raw = await callViaSubagent({
      agent: options?.agent,
      agentName: "evidence-cohort-teacher",
      prompt: `Return ONLY JSON matching this exact schema: {"schema_version":1,"proposed_body":string,"rationale":string,"confidence":number,"target_section":string,"scope":"section_local"|"skill_specific"|"task_family"|"general","mutation_operation":"add"|"refine"|"replace"|"remove","principle":string,"applicability":string,"failure_mode":string,"preserved_constraints":string[],"superseded_guidance":string[],"uncertainty":string[]}.\nCreate one minimal review-only SKILL.md body change. When search context is present, follow its strategy and make this proposal materially distinct from other likely candidates. Preserve current_body byte-for-byte outside one contiguous changed region. Add, replace, or remove at most 40 changed lines. Do not reflow headings, tables, or unrelated prose. Return the complete proposed body. Do not include transcript text.\n${JSON.stringify(input)}`,
      maxTurns: 1,
    });
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("The local teacher did not return a JSON object.");
    }
  };
}

export const liveCohortBodyTeacher: CohortBodyTeacher = makeLiveCohortBodyTeacher();

export function makeTraceCandidatePreparationLayer(options: {
  sqlite: Database;
  teacher?: CohortBodyTeacher;
  studentAgent?: LlmBackedAgent;
  studentModel?: string;
  searchDirs?: readonly string[];
  computeRevision?: (skillPath: string) => string | undefined;
  evolutionDeps?: Omit<CohortBodyEvolutionDeps, "appendAuditEntry" | "appendEvidenceEntry">;
  historicalTaskCalibrator?: HistoricalTaskCalibrator;
}): Layer.Layer<TraceCandidatePreparation, never, DuckDbAnalyticalStore> {
  return Layer.effect(
    TraceCandidatePreparation,
    Effect.gen(function* () {
      const analytical = yield* DuckDbAnalyticalStore;
      const prepare = Effect.fn("TraceCandidatePreparation.prepare")(function* (unknown: unknown) {
        const input = yield* Schema.decodeUnknownEffect(requestSchema)(unknown).pipe(
          Effect.mapError(
            (error) => new TraceCandidatePreparationError({ message: error.message }),
          ),
        );
        const installed = matchingInstalledSkill(
          input.pattern_id,
          options.searchDirs ?? getDefaultSkillSearchDirs(),
        );
        if (!installed)
          return yield* new TraceCandidatePreparationError({
            message: "Unsupported trace pattern or the traced skill is not installed locally.",
          });
        const skillId = installed.name.trim().toLowerCase();
        const computeRevision = options.computeRevision ?? computeSkillVersionHash;
        const revision = computeRevision(installed.skill_path);
        if (!revision)
          return yield* new TraceCandidatePreparationError({
            message: "Could not resolve the installed skill revision.",
          });
        const historicalSignal = (yield* analytical
          .querySkillSignals()
          .pipe(
            Effect.mapError(
              (error) => new TraceCandidatePreparationError({ message: error.message }),
            ),
          )).find((signal) => signal.skill_name.trim().toLowerCase() === skillId);
        const analyticalCandidates = yield* analytical
          .queryEvidenceCohortCandidates({
            pattern: {
              pattern_id: input.pattern_id,
              kind: "repeated_correlated_errors",
              skill_id: skillId,
              skill_name: installed.name,
            },
          })
          .pipe(
            Effect.mapError(
              (error) => new TraceCandidatePreparationError({ message: error.message }),
            ),
          );
        const byTrace = new Map<string, { hasError: boolean }>();
        for (const candidate of analyticalCandidates) {
          const existing = byTrace.get(candidate.trace_id) ?? {
            hasError: false,
          };
          existing.hasError ||= candidate.error_count > 0;
          byTrace.set(candidate.trace_id, existing);
        }
        const uniqueTraceCount = byTrace.size;
        const errorTraceCount = [...byTrace.values()].filter((trace) => trace.hasError).length;
        if (!supportsContrastiveRepeatedErrorPattern({ uniqueTraceCount, errorTraceCount })) {
          const sessionOnlyHistory =
            uniqueTraceCount === 0 && (historicalSignal?.trace_count ?? 0) > 0;
          if (sessionOnlyHistory) {
            return yield* prepareHistoricalTaskCandidate({
              analytical,
              sqlite: options.sqlite,
              teacher: options.teacher ?? liveCohortBodyTeacher,
              patternId: input.pattern_id,
              installed,
              skillId,
              revision,
              computeRevision,
              candidateCount: input.candidate_count ?? 3,
              calibrationRepetitions: input.calibration_repetitions ?? 3,
              calibrator: options.historicalTaskCalibrator,
            });
          }
          return {
            draft_id: null,
            pattern_id: input.pattern_id,
            cohort_fingerprint: null,
            target_revision: revision,
            readiness: "not_ready",
            failure_reason:
              "The exact pattern is no longer supported: it requires at least 3 unique traces, 2 error traces, and 1 successful counterexample.",
            evidence: { cohort_entries: 0, resolved_entries: 0 },
            candidate: null,
          } satisfies TraceCandidateReview;
        }
        const ids = analyticalCandidates.map((entry) => entry.skill_invocation_id);
        const placeholders = ids.map(() => "?").join(",");
        const rows =
          ids.length === 0
            ? []
            : (options.sqlite
                .query(
                  `SELECT
                    invocation.skill_invocation_id,
                    invocation.query,
                    prompt.prompt_text AS matched_prompt,
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
                .all(...ids) as Array<{
                skill_invocation_id: string;
                query: string | null;
                matched_prompt: string | null;
                triggered: number | null;
                invocation_mode: string | null;
                source: string | null;
                capture_mode: string | null;
                skill_version_hash: string | null;
                occurred_at: string | null;
                skill_path: string | null;
              }>);
        const packageMtimeMs = yield* Effect.try({
          try: () => latestPackageMtimeMs(installed.package_path),
          catch: (error) =>
            new TraceCandidatePreparationError({
              message: `Could not inspect the installed skill snapshot: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        const resolvedRows = new Map(
          rows.flatMap((row) => {
            const occurredAt = row.occurred_at ? Date.parse(row.occurred_at) : Number.NaN;
            const revisionResolution =
              row.skill_version_hash === revision
                ? ("captured" as const)
                : !row.skill_version_hash &&
                    Number.isFinite(occurredAt) &&
                    packageMtimeMs <= occurredAt &&
                    pathCanUseInstalledSnapshot(row.skill_path, installed.skill_path)
                  ? ("stable_installed_snapshot" as const)
                  : null;
            const task =
              boundedHistoricalTask(row.matched_prompt) ?? boundedHistoricalTask(row.query);
            const sourceExact = row.capture_mode === "hook" || row.source === "claude_code_replay";
            const eligibleTask =
              task !== null &&
              (row.invocation_mode === "explicit" ||
                sourceExact ||
                taskMentionsSkill(task, installed.name))
                ? task
                : null;
            return eligibleTask && revisionResolution
              ? [
                  [
                    row.skill_invocation_id,
                    { row, task: eligibleTask, revisionResolution },
                  ] as const,
                ]
              : [];
          }),
        );
        const candidates = analyticalCandidates.flatMap((candidate) => {
          const resolution = resolvedRows.get(candidate.skill_invocation_id);
          return resolution ? [{ ...candidate, source_excerpt: resolution.task }] : [];
        });
        if (candidates.length === 0) {
          return {
            draft_id: null,
            pattern_id: input.pattern_id,
            cohort_fingerprint: null,
            target_revision: revision,
            readiness: "not_ready",
            failure_reason:
              "Historical traces exist, but none can be resolved to a bounded task at the exact installed skill revision.",
            evidence: { cohort_entries: 0, resolved_entries: 0 },
            candidate: null,
          } satisfies TraceCandidateReview;
        }
        let cohortFailure: string | null = null;
        const materializedCohort = yield* materializeEvidenceCohort({
          schema_version: "1.0.0",
          selector_version: "local-trace-candidate/v1",
          pattern: {
            pattern_id: input.pattern_id,
            kind: "repeated_correlated_errors",
            skill_id: skillId,
            skill_name: installed.name,
          },
          target_skill: {
            skill_id: skillId,
            skill_name: installed.name,
            skill_path: installed.skill_path,
            revision,
          },
          source_allowlist: [...new Set(candidates.map((item) => item.source_id))],
          excerpt_limit_bytes: 512,
          request_limit_bytes: 8_192,
          candidates,
        }).pipe(
          Effect.catchTag("EvidenceCohortFailure", (error) => {
            cohortFailure = error.message;
            return Effect.succeed(null);
          }),
        );
        if (materializedCohort === null) {
          return {
            draft_id: null,
            pattern_id: input.pattern_id,
            cohort_fingerprint: null,
            target_revision: revision,
            readiness: "not_ready",
            failure_reason: cohortFailure ?? "The selected evidence is not ready for review.",
            evidence: { cohort_entries: 0, resolved_entries: 0 },
            candidate: null,
          } satisfies TraceCandidateReview;
        }
        const resolved = materializedCohort.entries.flatMap((entry) => {
          const resolution = resolvedRows.get(entry.source.skill_invocation_id);
          if (!resolution) return [];
          return [
            ResolvedEvidenceReference.make({
              ...entry.source,
              skill_revision: revision,
              revision_resolution: resolution.revisionResolution,
              query: resolution.task,
              should_trigger: Boolean(resolution.row.triggered),
            }),
          ];
        });
        const evolution = yield* Effect.tryPromise({
          try: () =>
            evolveBodyFromEvidenceCohort(
              {
                cohort: materializedCohort,
                resolved_evidence: resolved,
                teacher: options.teacher ?? liveCohortBodyTeacher,
                student_agent: options.studentAgent,
                student_model: options.studentModel,
              },
              {
                ...options.evolutionDeps,
                // Preparation is an ephemeral review operation. In particular it
                // must not create audit/evidence rows that look like a persisted
                // candidate or an applied proposal.
                appendAuditEntry: () => undefined,
                appendEvidenceEntry: () => undefined,
                computeRevision,
              },
            ),
          catch: (error) =>
            new TraceCandidatePreparationError({
              message: error instanceof Error ? error.message : "Candidate preparation failed.",
            }),
        });
        const draftPayload =
          evolution.status === "review_ready" && evolution.candidate
            ? {
                schema_version: 1 as const,
                cohort: {
                  schema_version: materializedCohort.schema_version,
                  selector_version: materializedCohort.selector_version,
                  pattern: materializedCohort.pattern,
                  target_skill: {
                    skill_id: materializedCohort.target_skill.skill_id,
                    skill_name: materializedCohort.target_skill.skill_name,
                    revision: materializedCohort.target_skill.revision,
                  },
                  excerpt_limit_bytes: materializedCohort.excerpt_limit_bytes,
                  request_limit_bytes: materializedCohort.request_limit_bytes,
                  entries: materializedCohort.entries.map((entry) => ({
                    ...entry,
                    ...(entry.redacted_excerpt === undefined
                      ? {}
                      : { redacted_excerpt: redactedPortableText(entry.redacted_excerpt) }),
                  })),
                  fingerprint: materializedCohort.fingerprint,
                },
                candidate: {
                  proposal_id: evolution.candidate.proposal_id,
                  target_revision: evolution.candidate.target_revision,
                  proposed_body: redactedPortableText(evolution.candidate.proposed_body),
                  rationale: redactedPortableText(evolution.candidate.rationale),
                },
                resolved_evidence: resolved.map((entry) =>
                  ResolvedEvidenceReference.make({
                    ...entry,
                    query: redactedPortableText(entry.query),
                  }),
                ),
              }
            : null;
        const persistedDraft = draftPayload
          ? yield* createOrGetPreparedEvaluationSubmissionDraft(options.sqlite, {
              draft_id: `eval-draft-${createHash("sha256")
                .update(JSON.stringify(draftPayload))
                .digest("hex")
                .slice(0, 32)}`,
              pattern_id: input.pattern_id,
              cohort_fingerprint: materializedCohort.fingerprint,
              skill_name: installed.name,
              skill_revision: revision,
              payload_json: JSON.stringify(draftPayload),
            }).pipe(
              Effect.mapError(
                (error) => new TraceCandidatePreparationError({ message: error.message }),
              ),
            )
          : null;
        return {
          draft_id: persistedDraft?.draft_id ?? null,
          pattern_id: input.pattern_id,
          cohort_fingerprint: materializedCohort.fingerprint,
          target_revision: revision,
          readiness: evolution.status === "review_ready" ? "review_ready" : "not_ready",
          failure_reason: evolution.status === "review_ready" ? null : evolution.reason,
          evidence: {
            cohort_entries: materializedCohort.entries.length,
            resolved_entries: resolved.length,
          },
          candidate: evolution.candidate
            ? {
                body: evolution.candidate.proposed_body,
                rationale: evolution.candidate.rationale,
                diff: {
                  changed_lines: evolution.candidate.changed_lines,
                  target_section: evolution.candidate.target_section,
                },
                uncertainty: evolution.candidate.uncertainty,
              }
            : null,
        } satisfies TraceCandidateReview;
      });
      return TraceCandidatePreparation.of({ prepare });
    }),
  );
}
