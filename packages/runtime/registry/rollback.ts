import { Effect, Result } from "effect";

import { registryRequest } from "./client.js";
import { RegistryLookupResponse, RegistryMutationResponse } from "./contracts.js";
import {
  failure,
  json,
  registryFailure,
  success,
  type RegistryProgramInput,
} from "./program-types.js";

export const runRegistryRollback = Effect.fn("selftune.registry.rollback")(function* (
  input: Extract<RegistryProgramInput, { operation: "rollback" }>,
) {
  if (!input.name) {
    return failure("rollback", {
      error: "Usage: selftune registry rollback <name> [--to=version] [--reason=text]",
    });
  }
  const lookup = yield* registryRequest(RegistryLookupResponse, {
    method: "GET",
    path: `?name=${encodeURIComponent(input.name)}`,
  }).pipe(Effect.result);
  if (Result.isFailure(lookup) || lookup.success.entries.length === 0) {
    return failure("rollback", { error: `Skill '${input.name}' not found in registry` });
  }
  const response = yield* registryRequest(RegistryMutationResponse, {
    method: "POST",
    path: `/${encodeURIComponent(lookup.success.entries[0].id)}/rollback`,
    body: { target_version: input.targetVersion, reason: input.reason },
  }).pipe(Effect.result);
  if (Result.isFailure(response)) return registryFailure("rollback", response.failure);
  return success(
    "rollback",
    json({
      success: true,
      name: input.name,
      message: "Rolled back. Run 'selftune registry sync' to update local installations.",
    }),
  );
});
