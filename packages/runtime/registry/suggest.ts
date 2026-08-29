import { Effect, Result } from "effect";

import { registryRequest } from "./client.js";
import {
  RegistryContributionMutationResponse,
  RegistryDetailResponse,
  RegistryInstallLookupResponse,
} from "./contracts.js";
import { RegistryPlatform } from "./platform.js";
import {
  failure,
  json,
  registryFailure,
  success,
  type RegistryProgramInput,
} from "./program-types.js";

export const runRegistrySuggest = Effect.fn("selftune.registry.suggest")(function* (
  input: Extract<RegistryProgramInput, { operation: "suggest" }>,
) {
  const platform = yield* RegistryPlatform;
  const prepared = yield* platform.preparePush(input).pipe(Effect.result);
  if (Result.isFailure(prepared)) return yield* prepared.failure;
  if (!prepared.success) {
    return failure("suggest", {
      error: "No SKILL.md found in the current directory.",
      guidance: { next_command: "cd <installed-skill-directory>" },
    });
  }
  const candidate = prepared.success;
  const lookup = yield* registryRequest(RegistryInstallLookupResponse, {
    method: "GET",
    path: `?name=${encodeURIComponent(candidate.name)}`,
  }).pipe(Effect.result);
  if (Result.isFailure(lookup)) return registryFailure("suggest", lookup.failure);
  const entry = lookup.success.entries[0];
  if (!entry) {
    return failure("suggest", {
      error: `Skill '${candidate.name}' is not managed by this workspace registry.`,
      guidance: { next_command: `selftune registry install ${candidate.name}` },
    });
  }
  const detail = yield* registryRequest(RegistryDetailResponse, {
    method: "GET",
    path: `/${encodeURIComponent(entry.id)}`,
  }).pipe(Effect.result);
  if (Result.isFailure(detail)) return registryFailure("suggest", detail.failure);
  const state = yield* platform.loadState();
  const installation = state.find((candidate) => candidate.entryId === entry.id);
  const base = installation
    ? detail.success.versions.find((version) => version.content_hash === installation.versionHash)
    : detail.success.versions.find((version) => version.is_current);
  if (!base) return failure("suggest", { error: "Registry entry has no current base version." });

  const formData = new FormData();
  formData.append(
    "metadata",
    JSON.stringify({
      baseVersionId: base.id,
      candidateVersion: candidate.version,
      candidateContentHash: candidate.archiveHash,
      summary: input.summary?.trim() || `Teammate revision based on ${base.version}`,
      files: candidate.manifest,
    }),
  );
  formData.append(
    "archive",
    new Blob([Uint8Array.from(candidate.archiveBuffer)], { type: "application/gzip" }),
    `${candidate.name}.tar.gz`,
  );
  const submitted = yield* registryRequest(RegistryContributionMutationResponse, {
    method: "POST",
    path: `/api/v1/collaboration/registry/${encodeURIComponent(entry.id)}/contributions`,
    formData,
  }).pipe(Effect.result);
  if (Result.isFailure(submitted)) return registryFailure("suggest", submitted.failure);
  return success(
    "suggest",
    json({
      success: true,
      contribution_id: submitted.success.id,
      skill: candidate.name,
      base_version: base.version,
      candidate_version: candidate.version,
      candidate_hash: candidate.archiveHash,
      files: candidate.manifest.length,
      status: submitted.success.status,
      message: "Submitted for creator review. No workspace installation was changed.",
    }),
  );
});
