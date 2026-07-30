/** Local-only preparation of a review candidate from a supported trace pattern. */
import { Context, Effect, Layer, Schema } from "effect";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createOrGetPreparedEvaluationSubmissionDraft } from "@selftune/local-store";

import {
  DuckDbAnalyticalStore,
  EvidenceCohortEntry,
  materializeEvidenceCohort,
} from "@selftune/observability";
import {
  ResolvedEvidenceReference,
  evolveBodyFromEvidenceCohort,
  type CohortBodyEvolutionDeps,
  type CohortBodyTeacher,
} from "@selftune/runtime/evolution/evidence-cohort-body-adapter";
import { callViaSubagent } from "@selftune/runtime/utils/llm-call";
import {
  computeSkillVersionHash,
  findInstalledSkillPackages,
  getDefaultSkillSearchDirs,
} from "@selftune/runtime/utils/skill-discovery";

/**
 * The durable hand-off is intentionally smaller than an EvidenceCohort: it
 * never persists a local path or source transcript.  It is decoded again at
 * the submission boundary before it can become a portable Cloud request.
 */
const preparedDraftSchema = Schema.Struct({
  schema_version: Schema.Literal(1),
  cohort: Schema.Struct({
    schema_version: Schema.Literal("1.0.0"),
    selector_version: Schema.String.check(Schema.isMaxLength(256)),
    pattern: Schema.Struct({
      pattern_id: Schema.String.check(Schema.isMaxLength(256)),
      kind: Schema.Literal("repeated_correlated_errors"),
      skill_id: Schema.String.check(Schema.isMaxLength(256)),
      skill_name: Schema.String.check(Schema.isMaxLength(256)),
    }),
    target_skill: Schema.Struct({
      skill_id: Schema.String.check(Schema.isMaxLength(256)),
      skill_name: Schema.String.check(Schema.isMaxLength(256)),
      revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
    excerpt_limit_bytes: Schema.Number,
    request_limit_bytes: Schema.Number,
    entries: Schema.Array(EvidenceCohortEntry).check(Schema.isMaxLength(14)),
    fingerprint: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  }),
  candidate: Schema.Struct({
    proposal_id: Schema.String.check(Schema.isMaxLength(128)),
    target_revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    proposed_body: Schema.String.check(Schema.isMaxLength(16_000)),
    rationale: Schema.String.check(Schema.isMaxLength(2_000)),
  }),
  resolved_evidence: Schema.Array(ResolvedEvidenceReference).check(Schema.isMaxLength(14)),
});
export type PreparedTraceCandidateDraft = typeof preparedDraftSchema.Type;

const redactedPortableText = (value: string): string =>
  value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
      "[redacted-private-key]",
    )
    .replace(
      /\b(?:api[_-]?key|token|secret|password|authorization|cookie|signature)\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/(?:^|([\s"'`]))(?:\/(?:[^\s"'`]+)|[a-zA-Z]:\\[^\s"'`]+)/g, "$1[local-path]");

export const decodePreparedTraceCandidateDraft = (value: unknown) =>
  Schema.decodeUnknownEffect(preparedDraftSchema)(value);

const requestSchema = Schema.Struct({
  pattern_id: Schema.String.check(Schema.isNonEmpty()),
});
export type TraceCandidateRequest = typeof requestSchema.Type;

export interface TraceCandidateReview {
  readonly draft_id: string | null;
  readonly pattern_id: string;
  readonly cohort_fingerprint: string | null;
  readonly target_revision: string | null;
  readonly readiness: "review_ready" | "not_ready";
  readonly failure_reason: string | null;
  readonly evidence: {
    readonly cohort_entries: number;
    readonly resolved_entries: number;
  };
  readonly candidate: {
    readonly body: string;
    readonly rationale: string;
    readonly diff: {
      readonly changed_lines: number;
      readonly target_section: string;
    };
    readonly uncertainty: readonly string[];
  } | null;
}

export class TraceCandidatePreparationError extends Schema.TaggedErrorClass<TraceCandidatePreparationError>()(
  "TraceCandidatePreparationError",
  { message: Schema.String },
) {}

export interface TraceCandidatePreparationService {
  readonly prepare: (
    input: unknown,
  ) => Effect.Effect<TraceCandidateReview, TraceCandidatePreparationError>;
}

const supportedPatternThreshold = {
  uniqueTraces: 3,
  errorTraces: 2,
  errorRatio: 0.5,
} as const;

export class TraceCandidatePreparation extends Context.Service<
  TraceCandidatePreparation,
  TraceCandidatePreparationService
>()("@selftune/local/TraceCandidatePreparation") {}

function matchingInstalledSkill(patternId: string, searchDirs: readonly string[]) {
  return findInstalledSkillPackages([...searchDirs]).find((skill) => {
    const id = skill.name.trim().toLowerCase();
    const digest = createHash("sha256")
      .update(`repeated_correlated_errors:${id}`)
      .digest("hex")
      .slice(0, 16);
    return patternId === `execution-pattern-${digest}`;
  });
}

export const liveCohortBodyTeacher: CohortBodyTeacher = async (input) => {
  const raw = await callViaSubagent({
    agentName: "evidence-cohort-teacher",
    prompt: `Return ONLY JSON matching this exact schema: {"schema_version":1,"proposed_body":string,"rationale":string,"confidence":number,"target_section":string,"scope":"section_local"|"skill_specific"|"task_family"|"general","mutation_operation":"add"|"refine"|"replace"|"remove","principle":string,"applicability":string,"failure_mode":string,"preserved_constraints":string[],"superseded_guidance":string[],"uncertainty":string[]}.\nCreate a minimal review-only SKILL.md body change. Do not include transcript text.\n${JSON.stringify(input)}`,
    maxTurns: 1,
  });
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("The local teacher did not return a JSON object.");
  }
};

export function makeTraceCandidatePreparationLayer(options: {
  sqlite: Database;
  teacher?: CohortBodyTeacher;
  searchDirs?: readonly string[];
  computeRevision?: (skillPath: string) => string | undefined;
  evolutionDeps?: Omit<CohortBodyEvolutionDeps, "appendAuditEntry" | "appendEvidenceEntry">;
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
        const candidates = yield* analytical
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
        for (const candidate of candidates) {
          const existing = byTrace.get(candidate.trace_id) ?? {
            hasError: false,
          };
          existing.hasError ||= candidate.error_count > 0;
          byTrace.set(candidate.trace_id, existing);
        }
        const uniqueTraceCount = byTrace.size;
        const errorTraceCount = [...byTrace.values()].filter((trace) => trace.hasError).length;
        const errorRatio = uniqueTraceCount === 0 ? 0 : errorTraceCount / uniqueTraceCount;
        if (
          uniqueTraceCount < supportedPatternThreshold.uniqueTraces ||
          errorTraceCount < supportedPatternThreshold.errorTraces ||
          errorRatio < supportedPatternThreshold.errorRatio
        ) {
          return {
            draft_id: null,
            pattern_id: input.pattern_id,
            cohort_fingerprint: null,
            target_revision: revision,
            readiness: "not_ready",
            failure_reason:
              "The exact pattern is no longer supported: it requires at least 3 unique traces, 2 error traces, and a 0.5 error-trace ratio.",
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
        const ids = materializedCohort.entries.map((entry) => entry.source.skill_invocation_id);
        const placeholders = ids.map(() => "?").join(",");
        const rows =
          ids.length === 0
            ? []
            : (options.sqlite
                .query(
                  `SELECT skill_invocation_id, query, triggered, skill_version_hash FROM skill_invocations WHERE skill_invocation_id IN (${placeholders}) AND skill_version_hash = ?`,
                )
                .all(...ids, revision) as Array<{
                skill_invocation_id: string;
                query: string | null;
                triggered: number | null;
                skill_version_hash: string;
              }>);
        const byId = new Map(rows.map((row) => [row.skill_invocation_id, row]));
        const resolved = materializedCohort.entries.flatMap((entry) => {
          const row = byId.get(entry.source.skill_invocation_id);
          if (!row?.query) return [];
          return [
            ResolvedEvidenceReference.make({
              ...entry.source,
              skill_revision: row.skill_version_hash,
              query: row.query,
              should_trigger: Boolean(row.triggered),
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
