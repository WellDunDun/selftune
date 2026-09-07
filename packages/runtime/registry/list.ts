import { Effect, Result } from "effect";

import { registryRequest } from "./client.js";
import { RegistryListResponse } from "./contracts.js";
import { registryFailure, success } from "./program-types.js";

export const runRegistryList = Effect.fn("selftune.registry.list")(function* () {
  const response = yield* registryRequest(RegistryListResponse, {
    method: "GET",
    path: "",
  }).pipe(Effect.result);
  if (Result.isFailure(response)) return registryFailure("list", response.failure);
  if (response.success.entries.length === 0) {
    return success(
      "list",
      JSON.stringify({
        message: "No entries in registry. Use 'selftune registry push' to publish a skill.",
      }),
    );
  }
  const entries = response.success.entries.map((entry) => ({
    name: entry.name,
    type: entry.entry_type,
    version: entry.current_version?.version || "—",
    pass_rate: entry.pass_rate,
    eval_count: entry.eval_count,
    description: entry.description,
  }));
  return success("list", JSON.stringify({ entries, total: entries.length }));
});
