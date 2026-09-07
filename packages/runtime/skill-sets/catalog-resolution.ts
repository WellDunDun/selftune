import { isAbsolute } from "node:path";

import {
  createSkillSet,
  LibraryError,
  type SkillSetManifest,
  type SkillSetSkillInput,
} from "@selftune/library";
import type {
  CatalogSkillSetSkillRequest,
  CreateSkillSetRequest,
} from "../dashboard-contract/requests.js";
import { Effect, Result, Schema } from "effect";

export const CatalogSkillResolutionPhase = Schema.Literals([
  "resolving",
  "downloading",
  "validating",
  "materializing",
  "ready",
]);
export type CatalogSkillResolutionPhase = typeof CatalogSkillResolutionPhase.Type;

export class CatalogSkillResolutionProgress extends Schema.Class<CatalogSkillResolutionProgress>(
  "CatalogSkillResolutionProgress",
)({
  skill_name: Schema.String,
  catalog_id: Schema.String,
  phase: CatalogSkillResolutionPhase,
  message: Schema.String,
}) {}

export class CatalogSkillResolverFailure extends Schema.TaggedErrorClass<CatalogSkillResolverFailure>()(
  "CatalogSkillResolverFailure",
  {
    skill_name: Schema.String,
    catalog_id: Schema.String,
    phase: CatalogSkillResolutionPhase,
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const CatalogSkillResolutionFailureDetail = Schema.Struct({
  skill_name: Schema.String,
  catalog_id: Schema.String,
  phase: CatalogSkillResolutionPhase,
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type CatalogSkillResolutionFailureDetail = typeof CatalogSkillResolutionFailureDetail.Type;

export class CatalogSkillSetResolutionError extends Schema.TaggedErrorClass<CatalogSkillSetResolutionError>()(
  "CatalogSkillSetResolutionError",
  {
    code: Schema.Literal("CATALOG_SKILL_RESOLUTION_FAILED"),
    message: Schema.String,
    failures: Schema.Array(CatalogSkillResolutionFailureDetail),
    progress: Schema.Array(CatalogSkillResolutionProgress),
    retryable: Schema.Boolean,
  },
) {}

export class SkillSetCreationError extends Schema.TaggedErrorClass<SkillSetCreationError>()(
  "SkillSetCreationError",
  {
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export interface ResolvedCatalogSkillPackage {
  readonly name: string;
  readonly package_path: string;
  readonly content_hash?: string;
  readonly upstream_revision?: string;
}

export interface CatalogSkillPackageResolver {
  readonly resolve: (
    input: CatalogSkillSetSkillRequest,
    report: (progress: CatalogSkillResolutionProgress) => void,
  ) => Effect.Effect<ResolvedCatalogSkillPackage, CatalogSkillResolverFailure>;
}

export interface SkillSetCreationResult extends SkillSetManifest {
  readonly resolution_progress: ReadonlyArray<CatalogSkillResolutionProgress>;
}

export interface CreateSkillSetWithCatalogResolutionOptions {
  readonly resolver?: CatalogSkillPackageResolver;
  readonly onProgress?: (progress: CatalogSkillResolutionProgress) => void;
  readonly create?: (
    input: CreateSkillSetRequest & { skills: SkillSetSkillInput[] },
  ) => SkillSetManifest;
}

function isCatalogSkill(
  skill: CreateSkillSetRequest["skills"][number],
): skill is CatalogSkillSetSkillRequest {
  return "catalog_id" in skill;
}

function failureDetail(failure: CatalogSkillResolverFailure): CatalogSkillResolutionFailureDetail {
  return {
    skill_name: failure.skill_name,
    catalog_id: failure.catalog_id,
    phase: failure.phase,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

function unavailableResolverFailure(
  skill: CatalogSkillSetSkillRequest,
): CatalogSkillResolverFailure {
  return CatalogSkillResolverFailure.make({
    skill_name: skill.name,
    catalog_id: skill.catalog_id,
    phase: "resolving",
    code: "CATALOG_RESOLVER_UNAVAILABLE",
    message: `Catalog package resolution is unavailable for "${skill.name}".`,
    retryable: false,
  });
}

function invalidResolvedPackageFailure(
  skill: CatalogSkillSetSkillRequest,
  message: string,
): CatalogSkillResolverFailure {
  return CatalogSkillResolverFailure.make({
    skill_name: skill.name,
    catalog_id: skill.catalog_id,
    phase: "validating",
    code: "INVALID_CATALOG_PACKAGE",
    message,
    retryable: false,
  });
}

function validateResolvedPackage(
  skill: CatalogSkillSetSkillRequest,
  resolved: ResolvedCatalogSkillPackage,
): Effect.Effect<SkillSetSkillInput, CatalogSkillResolverFailure> {
  if (resolved.name !== skill.name) {
    return Effect.fail(
      invalidResolvedPackageFailure(
        skill,
        `Catalog package identity mismatch: expected "${skill.name}" but received "${resolved.name}".`,
      ),
    );
  }
  if (!isAbsolute(resolved.package_path)) {
    return Effect.fail(
      invalidResolvedPackageFailure(
        skill,
        `Catalog materializer returned a non-absolute package path for "${skill.name}".`,
      ),
    );
  }
  return Effect.succeed({ name: resolved.name, package_path: resolved.package_path });
}

const resolveCatalogSkill = Effect.fn("SkillSets.resolveCatalogSkill")(function* (
  skill: CatalogSkillSetSkillRequest,
  options: CreateSkillSetWithCatalogResolutionOptions,
  progress: CatalogSkillResolutionProgress[],
) {
  const report = (entry: CatalogSkillResolutionProgress): void => {
    progress.push(entry);
    options.onProgress?.(entry);
  };
  report(
    CatalogSkillResolutionProgress.make({
      skill_name: skill.name,
      catalog_id: skill.catalog_id,
      phase: "resolving",
      message: `Resolving exact catalog package for "${skill.name}".`,
    }),
  );
  const resolver = options.resolver;
  if (!resolver) return yield* unavailableResolverFailure(skill);
  const resolved = yield* resolver.resolve(skill, report);
  report(
    CatalogSkillResolutionProgress.make({
      skill_name: skill.name,
      catalog_id: skill.catalog_id,
      phase: "validating",
      message: `Validating materialized package identity for "${skill.name}".`,
    }),
  );
  const local = yield* validateResolvedPackage(skill, resolved);
  report(
    CatalogSkillResolutionProgress.make({
      skill_name: skill.name,
      catalog_id: skill.catalog_id,
      phase: "ready",
      message: `Catalog package "${skill.name}" is ready locally.`,
    }),
  );
  return local;
});

export const createSkillSetWithCatalogResolution = Effect.fn(
  "SkillSets.createWithCatalogResolution",
)(function* (
  input: CreateSkillSetRequest,
  options: CreateSkillSetWithCatalogResolutionOptions = {},
) {
  const progress: CatalogSkillResolutionProgress[] = [];
  const results = yield* Effect.forEach(
    input.skills,
    (skill) =>
      isCatalogSkill(skill)
        ? resolveCatalogSkill(skill, options, progress).pipe(Effect.result)
        : Effect.succeed(skill).pipe(Effect.result),
    { concurrency: 1 },
  );
  const failures = results.flatMap((result) =>
    Result.isFailure(result) ? [failureDetail(result.failure)] : [],
  );
  if (failures.length > 0) {
    return yield* CatalogSkillSetResolutionError.make({
      code: "CATALOG_SKILL_RESOLUTION_FAILED",
      message: `${failures.length} catalog skill${failures.length === 1 ? "" : "s"} could not be prepared.`,
      failures,
      progress,
      retryable: failures.some((failure) => failure.retryable),
    });
  }
  const skills = results.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []));
  const manifest = yield* Effect.try({
    try: () =>
      (options.create ?? createSkillSet)({
        name: input.name,
        description: input.description,
        harnesses: input.harnesses,
        skills,
      }),
    catch: (cause) =>
      SkillSetCreationError.make({
        code: cause instanceof LibraryError ? cause.code : "SKILL_SET_CREATION_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: cause instanceof LibraryError && cause.retryable,
      }),
  });
  return { ...manifest, resolution_progress: progress } satisfies SkillSetCreationResult;
});
