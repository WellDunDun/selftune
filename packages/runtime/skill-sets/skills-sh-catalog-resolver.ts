import {
  materializeSkillsShCatalogEntry,
  type SkillsShCatalogMaterializationError,
  type SkillsShCatalogMaterializationProgress,
  type SkillsShCatalogMaterializeOptions,
} from "@selftune/library/skills-sh-catalog";
import { Effect } from "effect";

import type { CatalogSkillSetSkillRequest } from "../dashboard-contract/requests.js";
import {
  CatalogSkillResolutionProgress,
  CatalogSkillResolverFailure,
  type CatalogSkillPackageResolver,
  type CatalogSkillResolutionPhase,
} from "./catalog-resolution.js";

export type SkillsShCatalogResolverOptions = Omit<SkillsShCatalogMaterializeOptions, "onProgress">;

function resolutionPhase(
  progress: SkillsShCatalogMaterializationProgress,
): CatalogSkillResolutionPhase {
  switch (progress.stage) {
    case "fetching":
      return "downloading";
    case "validating":
      return "validating";
    case "staging":
    case "complete":
      return "materializing";
  }
}

function progressMessage(progress: SkillsShCatalogMaterializationProgress): string {
  switch (progress.stage) {
    case "fetching":
      return "Downloading the exact skills.sh package snapshot.";
    case "validating":
      return "Validating the skills.sh package contents and identity.";
    case "staging":
      return `Materializing ${progress.file_count} files (${progress.total_bytes} bytes) in the immutable Library.`;
    case "complete":
      return progress.reused
        ? "Reusing the verified immutable Library package."
        : "Materialized the package in the immutable Library.";
  }
}

function failurePhase(error: SkillsShCatalogMaterializationError): CatalogSkillResolutionPhase {
  switch (error._tag) {
    case "SkillsShCatalogFetchError":
    case "SkillsShCatalogDownloadHttpError":
      return "downloading";
    case "SkillsShCatalogDownloadDecodeError":
    case "SkillsShCatalogIntegrityError":
    case "SkillsShCatalogPathError":
      return "validating";
    case "SkillsShCatalogStorageError":
      return "materializing";
  }
}

function failureCode(error: SkillsShCatalogMaterializationError): string {
  switch (error._tag) {
    case "SkillsShCatalogFetchError":
      return "CATALOG_FETCH_FAILED";
    case "SkillsShCatalogDownloadHttpError":
      return "CATALOG_HTTP_ERROR";
    case "SkillsShCatalogDownloadDecodeError":
      return "CATALOG_DECODE_ERROR";
    case "SkillsShCatalogIntegrityError":
      return "CATALOG_INTEGRITY_ERROR";
    case "SkillsShCatalogPathError":
      return "CATALOG_PATH_ERROR";
    case "SkillsShCatalogStorageError":
      return "CATALOG_STORAGE_ERROR";
  }
}

function retryable(error: SkillsShCatalogMaterializationError): boolean {
  if (error._tag === "SkillsShCatalogFetchError") return true;
  if (error._tag === "SkillsShCatalogDownloadHttpError") {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error._tag === "SkillsShCatalogStorageError";
}

function mapMaterializationFailure(
  skill: CatalogSkillSetSkillRequest,
  error: SkillsShCatalogMaterializationError,
): CatalogSkillResolverFailure {
  return CatalogSkillResolverFailure.make({
    skill_name: skill.name,
    catalog_id: skill.catalog_id,
    phase: failurePhase(error),
    code: failureCode(error),
    message: error.message,
    retryable: retryable(error),
  });
}

function missingDownloadUrlFailure(
  skill: CatalogSkillSetSkillRequest,
): CatalogSkillResolverFailure {
  return CatalogSkillResolverFailure.make({
    skill_name: skill.name,
    catalog_id: skill.catalog_id,
    phase: "resolving",
    code: "CATALOG_DOWNLOAD_URL_MISSING",
    message: `Catalog skill "${skill.name}" does not include an exact download URL. Refresh catalog suggestions and try again.`,
    retryable: true,
  });
}

/** Resolves an exact skills.sh catalog reference into an immutable local package. */
export function makeSkillsShCatalogPackageResolver(
  options: SkillsShCatalogResolverOptions = {},
): CatalogSkillPackageResolver {
  return {
    resolve: (skill, report) => {
      if (!skill.download_url) return Effect.fail(missingDownloadUrlFailure(skill));
      return materializeSkillsShCatalogEntry(
        {
          name: skill.name,
          catalog_id: skill.catalog_id,
          source: skill.source,
          install_spec: skill.install_spec,
          download_url: skill.download_url,
        },
        {
          ...options,
          onProgress: (progress) =>
            report(
              CatalogSkillResolutionProgress.make({
                skill_name: skill.name,
                catalog_id: skill.catalog_id,
                phase: resolutionPhase(progress),
                message: progressMessage(progress),
              }),
            ),
        },
      ).pipe(
        Effect.map((materialized) => {
          const resolved = {
            name: materialized.name,
            package_path: materialized.package_path,
            content_hash: materialized.content_hash,
          };
          return materialized.upstream_revision
            ? { ...resolved, upstream_revision: materialized.upstream_revision }
            : resolved;
        }),
        Effect.mapError((error) => mapMaterializationFailure(skill, error)),
      );
    },
  };
}
