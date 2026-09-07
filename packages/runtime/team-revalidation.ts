import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  HostedSkillSetRevalidationSummaryReceipt,
  HostedSkillSetRevalidationSummaryRequest,
} from "@selftune/control-plane";

const STATE_DIRECTORY = "team-revalidation";
const STATE_FILE = "state-v1.json";
const EVIDENCE_DIRECTORY = "evidence";
const MAX_RAW_EVIDENCE_BYTES = 10 * 1024 * 1024;
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const SafeSummary = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

const SupportedEnvironment = Schema.Struct({
  harness: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  models: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))).check(
    Schema.isMaxLength(100),
  ),
});

const StoredValidation = Schema.Struct({
  assignmentId: Identifier,
  releaseId: Identifier,
  source: Schema.Struct({
    kind: Schema.Literals(["team_release", "registry", "local"]),
    revisionSha256: Sha256,
    reference: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  }),
  reviewBy: Schema.Number,
  supportedEnvironments: Schema.Array(SupportedEnvironment).check(Schema.isMaxLength(20)),
  dependencyFingerprint: Sha256,
  harnessFingerprint: Sha256,
  policyFingerprint: Sha256,
  outcome: Schema.Literals(["passed", "failed"]),
  summary: SafeSummary,
  validatedAt: Schema.Number,
  evidenceFile: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
});
type StoredValidation = typeof StoredValidation.Type;

const StoredState = Schema.Struct({
  version: Schema.Literal(1),
  validations: Schema.Array(StoredValidation),
  summaryOutbox: Schema.optional(
    Schema.Array(
      Schema.Struct({
        request: Schema.Struct({
          request_id: Identifier,
          assignment_id: Identifier,
          release_id: Identifier,
          lifecycle_sequence: Schema.Number,
          status: Schema.Literals(["ready", "needs_review", "could_not_test"]),
          observed_at: Schema.Number,
        }),
        deliveredAt: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
});
type StoredState = typeof StoredState.Type;

export type TeamRevalidationReasonCode =
  | "source_changed"
  | "dependencies_changed"
  | "harness_changed"
  | "policy_changed"
  | "review_due"
  | "last_validation_failed";

export type TeamRevalidationStatus =
  | "never_validated"
  | "current"
  | "revalidation_required"
  | "failed";

export interface TeamRevalidationEnvironment {
  readonly harness: string;
  readonly models: ReadonlyArray<string>;
}

export interface TeamRevalidationCurrentContext {
  readonly assignmentId: string;
  readonly releaseId: string;
  readonly sourceRevisionSha256: string;
  readonly dependencyFingerprint: string;
  readonly harnessFingerprint: string;
  readonly policyFingerprint: string;
}

export interface TeamRevalidationHostedSummary {
  readonly assignment_id: string;
  readonly release_id: string;
  readonly status: TeamRevalidationStatus;
  readonly reason_codes: ReadonlyArray<TeamRevalidationReasonCode>;
  readonly validated_at: number | null;
  readonly review_by: number | null;
  readonly supported_harnesses: ReadonlyArray<string>;
  readonly supported_model_count: number;
}

export class TeamSkillSetRevalidationError extends Schema.TaggedErrorClass<TeamSkillSetRevalidationError>()(
  "TeamSkillSetRevalidationError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

function failure(code: string, message: string) {
  return new TeamSkillSetRevalidationError({ code, message });
}

function decodeState(source: string): Effect.Effect<StoredState, TeamSkillSetRevalidationError> {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(StoredState))(source).pipe(
    Effect.mapError(() =>
      failure("REVALIDATION_STATE_CORRUPT", "The local revalidation state is invalid."),
    ),
  );
}

function checkedIdentifier(
  value: string,
  field: string,
): Effect.Effect<string, TeamSkillSetRevalidationError> {
  return Schema.decodeUnknownEffect(Identifier)(value).pipe(
    Effect.mapError(() => failure("REVALIDATION_INVALID_INPUT", `${field} is invalid.`)),
  );
}

function checkedSha(
  value: string,
  field: string,
): Effect.Effect<string, TeamSkillSetRevalidationError> {
  return Schema.decodeUnknownEffect(Sha256)(value).pipe(
    Effect.mapError(() => failure("REVALIDATION_INVALID_INPUT", `${field} must be a SHA-256.`)),
  );
}

function evaluate(
  validation: StoredValidation | undefined,
  context: TeamRevalidationCurrentContext,
  now: number,
) {
  if (!validation) return { status: "never_validated" as const, reasonCodes: [] };
  const reasons: TeamRevalidationReasonCode[] = [];
  if (validation.source.revisionSha256 !== context.sourceRevisionSha256)
    reasons.push("source_changed");
  if (validation.dependencyFingerprint !== context.dependencyFingerprint)
    reasons.push("dependencies_changed");
  if (validation.harnessFingerprint !== context.harnessFingerprint) reasons.push("harness_changed");
  if (validation.policyFingerprint !== context.policyFingerprint) reasons.push("policy_changed");
  if (now >= validation.reviewBy) reasons.push("review_due");
  if (validation.outcome === "failed") reasons.push("last_validation_failed");
  if (validation.outcome === "failed") return { status: "failed" as const, reasonCodes: reasons };
  return reasons.length > 0
    ? { status: "revalidation_required" as const, reasonCodes: reasons }
    : { status: "current" as const, reasonCodes: [] };
}

function summary(
  validation: StoredValidation | undefined,
  context: TeamRevalidationCurrentContext,
  now: number,
): TeamRevalidationHostedSummary {
  const state = evaluate(validation, context, now);
  const harnesses = validation
    ? [...new Set(validation.supportedEnvironments.map((item) => item.harness))].toSorted()
    : [];
  return {
    assignment_id: context.assignmentId,
    release_id: context.releaseId,
    status: state.status,
    reason_codes: state.reasonCodes,
    validated_at: validation?.validatedAt ?? null,
    review_by: validation?.reviewBy ?? null,
    supported_harnesses: harnesses.slice(0, 20),
    supported_model_count:
      validation?.supportedEnvironments.reduce((count, item) => count + item.models.length, 0) ?? 0,
  };
}

function localMetadata(validation: StoredValidation | undefined) {
  if (!validation) return null;
  return {
    source: validation.source,
    reviewBy: validation.reviewBy,
    supportedEnvironments: validation.supportedEnvironments,
    outcome: validation.outcome,
    summary: validation.summary,
  } as const;
}

export interface TeamSkillSetRevalidationRuntimeOptions {
  readonly configRoot: string;
  readonly now?: () => number;
  readonly hosted?: {
    readonly publishRevalidationSummary: (
      request: HostedSkillSetRevalidationSummaryRequest,
    ) => Promise<HostedSkillSetRevalidationSummaryReceipt>;
  };
}

export function makeTeamSkillSetRevalidationRuntime(
  options: TeamSkillSetRevalidationRuntimeOptions,
) {
  const directory = join(options.configRoot, STATE_DIRECTORY);
  const evidenceDirectory = join(directory, EVIDENCE_DIRECTORY);
  const statePath = join(directory, STATE_FILE);
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<StoredState> => {
    try {
      return await Effect.runPromise(decodeState(await readFile(statePath, "utf8")));
    } catch (cause) {
      if (cause instanceof TeamSkillSetRevalidationError) throw cause;
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return { version: 1, validations: [], summaryOutbox: [] };
      throw failure(
        "REVALIDATION_STATE_CORRUPT",
        "The local revalidation state could not be read.",
      );
    }
  };

  const write = async (state: StoredState): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.state-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, statePath);
  };

  const serialized = <A>(operation: () => Promise<A>): Promise<A> => {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  };

  const transportStatus = (status: TeamRevalidationStatus) =>
    status === "current"
      ? ("ready" as const)
      : status === "failed"
        ? ("could_not_test" as const)
        : ("needs_review" as const);

  const publishCurrentSummary = async (
    storedState: StoredState,
    context: TeamRevalidationCurrentContext,
    lifecycle: ReturnType<typeof evaluate>,
  ) => {
    if (!options.hosted) return { syncStatus: "local_only" as const };
    const observedAt = now();
    const status = transportStatus(lifecycle.status);
    const binding = JSON.stringify({
      assignmentId: context.assignmentId,
      releaseId: context.releaseId,
      source: context.sourceRevisionSha256,
      dependency: context.dependencyFingerprint,
      harness: context.harnessFingerprint,
      policy: context.policyFingerprint,
      status,
    });
    const requestId = `revalidation_v1_${createHash("sha256").update(binding).digest("hex").slice(0, 32)}`;
    const request: HostedSkillSetRevalidationSummaryRequest = {
      request_id: requestId,
      assignment_id: context.assignmentId,
      release_id: context.releaseId,
      lifecycle_sequence: Math.max(
        1,
        observedAt,
        ...(storedState.summaryOutbox ?? [])
          .filter((item) => item.request.assignment_id === context.assignmentId)
          .map((item) => item.request.lifecycle_sequence + 1),
      ),
      status,
      observed_at: Math.max(1, observedAt),
    };
    const existing = (storedState.summaryOutbox ?? []).find(
      (item) => item.request.request_id === requestId,
    );
    const outbound = existing?.request ?? request;
    const queued = existing
      ? storedState
      : {
          ...storedState,
          summaryOutbox: [...(storedState.summaryOutbox ?? []), { request, deliveredAt: null }],
        };
    if (!existing) await write(queued);
    if (existing?.deliveredAt !== null && existing?.deliveredAt !== undefined)
      return { syncStatus: "synced" as const };
    try {
      const receipt = await options.hosted.publishRevalidationSummary(outbound);
      if (
        receipt.request_id !== outbound.request_id ||
        receipt.assignment_id !== outbound.assignment_id ||
        receipt.release_id !== outbound.release_id ||
        receipt.status !== outbound.status
      )
        throw failure(
          "REVALIDATION_SUMMARY_BINDING_MISMATCH",
          "Cloud returned a lifecycle summary for a different assignment.",
        );
      const latest = await read();
      await write({
        ...latest,
        summaryOutbox: (latest.summaryOutbox ?? []).map((item) =>
          item.request.request_id === requestId ? { ...item, deliveredAt: observedAt } : item,
        ),
      });
      return { syncStatus: "synced" as const };
    } catch {
      return { syncStatus: "pending" as const };
    }
  };

  const status = (context: TeamRevalidationCurrentContext) =>
    serialized(async () => {
      await Effect.runPromise(
        Effect.all([
          checkedIdentifier(context.assignmentId, "assignmentId"),
          checkedIdentifier(context.releaseId, "releaseId"),
          checkedSha(context.sourceRevisionSha256, "sourceRevisionSha256"),
          checkedSha(context.dependencyFingerprint, "dependencyFingerprint"),
          checkedSha(context.harnessFingerprint, "harnessFingerprint"),
          checkedSha(context.policyFingerprint, "policyFingerprint"),
        ]),
      );
      const storedState = await read();
      const stored = storedState.validations.find(
        (item) =>
          item.assignmentId === context.assignmentId && item.releaseId === context.releaseId,
      );
      const evaluated = evaluate(stored, context, now());
      const transport = await publishCurrentSummary(storedState, context, evaluated);
      return {
        ...evaluated,
        ...transport,
        localMetadata: localMetadata(stored),
        hostedSummary: summary(stored, context, now()),
      };
    });

  const recordValidation = (input: {
    readonly assignmentId: string;
    readonly releaseId: string;
    readonly source: {
      readonly kind: "team_release" | "registry" | "local";
      readonly revisionSha256: string;
      readonly reference?: string;
    };
    readonly reviewBy: string;
    readonly supportedEnvironments: ReadonlyArray<TeamRevalidationEnvironment>;
    readonly dependencyFingerprint: string;
    readonly harnessFingerprint: string;
    readonly policyFingerprint: string;
    readonly outcome: "passed" | "failed";
    readonly summary: string;
    readonly rawEvidence: Uint8Array;
  }) =>
    serialized(async () => {
      const validatedAt = now();
      const reviewBy = Date.parse(input.reviewBy);
      if (!Number.isFinite(reviewBy) || reviewBy <= validatedAt)
        throw failure(
          "REVALIDATION_INVALID_REVIEW_BY",
          "reviewBy must be a future ISO date when validation is recorded.",
        );
      if (input.rawEvidence.byteLength === 0)
        throw failure("REVALIDATION_EVIDENCE_REQUIRED", "Raw local evidence is required.");
      if (input.rawEvidence.byteLength > MAX_RAW_EVIDENCE_BYTES)
        throw failure(
          "REVALIDATION_EVIDENCE_TOO_LARGE",
          "Raw local evidence must be 10 MB or smaller.",
        );
      const evidenceFile = `${randomUUID()}.bin`;
      const candidate: StoredValidation = {
        assignmentId: input.assignmentId,
        releaseId: input.releaseId,
        source: input.source,
        reviewBy,
        supportedEnvironments: input.supportedEnvironments.map((environment) => ({
          harness: environment.harness,
          models: [...environment.models],
        })),
        dependencyFingerprint: input.dependencyFingerprint,
        harnessFingerprint: input.harnessFingerprint,
        policyFingerprint: input.policyFingerprint,
        outcome: input.outcome,
        summary: input.summary,
        validatedAt,
        evidenceFile,
      };
      const decoded = await Effect.runPromise(
        Schema.decodeUnknownEffect(StoredValidation)(candidate).pipe(
          Effect.mapError(() =>
            failure("REVALIDATION_INVALID_INPUT", "The validation metadata is invalid."),
          ),
        ),
      );
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      const rawEvidencePath = join(evidenceDirectory, evidenceFile);
      await writeFile(rawEvidencePath, input.rawEvidence, { mode: 0o600, flag: "wx" });
      const stored = await read();
      await write({
        version: 1,
        summaryOutbox: stored.summaryOutbox ?? [],
        validations: [
          ...stored.validations.filter(
            (item) =>
              item.assignmentId !== input.assignmentId || item.releaseId !== input.releaseId,
          ),
          decoded,
        ],
      });
      const context: TeamRevalidationCurrentContext = {
        assignmentId: decoded.assignmentId,
        releaseId: decoded.releaseId,
        sourceRevisionSha256: decoded.source.revisionSha256,
        dependencyFingerprint: decoded.dependencyFingerprint,
        harnessFingerprint: decoded.harnessFingerprint,
        policyFingerprint: decoded.policyFingerprint,
      };
      const evaluated = evaluate(decoded, context, validatedAt);
      return {
        ...evaluated,
        rawEvidencePath,
        localMetadata: localMetadata(decoded),
        hostedSummary: summary(decoded, context, validatedAt),
      };
    });

  return { recordValidation, status } as const;
}
