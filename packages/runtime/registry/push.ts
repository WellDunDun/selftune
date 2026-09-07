import { Effect, Result } from "effect";

import { registryRequest } from "./client.js";
import { RegistryLookupResponse, RegistryMutationResponse } from "./contracts.js";
import { RegistryPlatform, type PreparedRegistryPush } from "./platform.js";
import {
  failure,
  RegistryOperationError,
  success,
  type RegistryProgramInput,
  type RegistryProgramResult,
} from "./program-types.js";

function progress(prepared: PreparedRegistryPush): string {
  return `Pushing ${prepared.name} v${prepared.version} (${(prepared.archiveBuffer.length / 1024).toFixed(1)} KB, ${prepared.manifest.length} files)...`;
}

function requestFailure(prepared: PreparedRegistryPush, message: string): RegistryProgramResult {
  return {
    operation: "push",
    stdout: [progress(prepared)],
    stderr: [
      JSON.stringify({ error: message, guidance: { next_command: "selftune registry list" } }),
    ],
    exitCode: 1,
  };
}

export const runRegistryPush = Effect.fn("selftune.registry.push")(function* (
  input: Extract<RegistryProgramInput, { operation: "push" }>,
) {
  const platform = yield* RegistryPlatform;
  const preparedResult = yield* platform.preparePush(input).pipe(Effect.result);
  if (Result.isFailure(preparedResult)) {
    if (preparedResult.failure instanceof RegistryOperationError) {
      return failure("push", { error: preparedResult.failure.message });
    }
    return yield* preparedResult.failure;
  }
  const prepared = preparedResult.success;
  if (!prepared) {
    return failure("push", {
      error: "No SKILL.md found in current directory. Navigate to a skill folder first.",
      guidance: { next_command: "cd <skill-directory>" },
    });
  }
  const formData = new FormData();
  formData.append(
    "metadata",
    JSON.stringify({
      name: prepared.name,
      entry_type: "skill",
      description: prepared.description,
      version: prepared.version,
      change_summary: input.summary,
      file_manifest: prepared.manifest,
      content_hash: prepared.archiveHash,
    }),
  );
  formData.append(
    "archive",
    new Blob([Uint8Array.from(prepared.archiveBuffer)], { type: "application/gzip" }),
    `${prepared.name}.tar.gz`,
  );
  const lookup = yield* registryRequest(RegistryLookupResponse, {
    method: "GET",
    path: `?name=${encodeURIComponent(prepared.name)}`,
  }).pipe(Effect.result);
  const path =
    Result.isSuccess(lookup) && lookup.success.entries.length > 0
      ? `/${encodeURIComponent(lookup.success.entries[0].id)}/versions`
      : "";
  const mutation = yield* registryRequest(RegistryMutationResponse, {
    method: "POST",
    path,
    formData,
  }).pipe(Effect.result);
  if (Result.isFailure(mutation)) return requestFailure(prepared, mutation.failure.message);
  return success(
    "push",
    progress(prepared),
    JSON.stringify({
      success: true,
      name: prepared.name,
      version: prepared.version,
      files: prepared.manifest.length,
      size: prepared.archiveBuffer.length,
      hash: prepared.archiveHash,
    }),
  );
});
