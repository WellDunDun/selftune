import { Effect, Result } from "effect";

import { registryRequest } from "./client.js";
import { RegistryHistoryResponse, RegistryLookupResponse } from "./contracts.js";
import {
  failure,
  json,
  registryFailure,
  success,
  type RegistryProgramInput,
} from "./program-types.js";

export const runRegistryHistory = Effect.fn("selftune.registry.history")(function* (
  input: Extract<RegistryProgramInput, { operation: "history" }>,
) {
  if (!input.name) return failure("history", { error: "Usage: selftune registry history <name>" });
  const lookup = yield* registryRequest(RegistryLookupResponse, {
    method: "GET",
    path: `?name=${encodeURIComponent(input.name)}`,
  }).pipe(Effect.result);
  if (Result.isFailure(lookup) || lookup.success.entries.length === 0) {
    return failure("history", { error: `Skill '${input.name}' not found in registry` });
  }
  const response = yield* registryRequest(RegistryHistoryResponse, {
    method: "GET",
    path: `/${encodeURIComponent(lookup.success.entries[0].id)}/versions`,
  }).pipe(Effect.result);
  if (Result.isFailure(response)) return registryFailure("history", response.failure);
  return success(
    "history",
    json({
      name: input.name,
      versions: response.success.versions.map((version) => ({
        version: version.version,
        status: version.is_current ? "current" : version.rolled_back ? "rolled_back" : "previous",
        pass_rate: version.aggregate_pass_rate,
        sessions: version.aggregate_sessions,
        summary: version.change_summary,
        pushed_at: version.pushed_at,
      })),
    }),
  );
});
