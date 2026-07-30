import { Effect, Result } from "effect";

import { registryRequest } from "./client.js";
import { RegistryStatusResponse } from "./contracts.js";
import { RegistryPlatform } from "./platform.js";
import { json, registryFailure, success } from "./program-types.js";

export const runRegistryStatus = Effect.fn("selftune.registry.status")(function* () {
  const platform = yield* RegistryPlatform;
  const state = yield* platform.loadState();
  if (state.length === 0) {
    return success("status", json({ message: "No registry installations found." }));
  }
  const response = yield* registryRequest(RegistryStatusResponse, {
    method: "POST",
    path: "/sync",
    body: {
      installations: state.map((entry) => ({
        entry_id: entry.entryId,
        current_version_hash: entry.versionHash,
      })),
    },
  }).pipe(Effect.result);
  if (Result.isFailure(response)) return registryFailure("status", response.failure);
  const installations = response.success.entries.map((entry) => ({
    name: entry.name,
    installed: entry.current_version,
    latest: entry.latest_version,
    status: entry.has_update ? "behind" : "up-to-date",
  }));
  return success(
    "status",
    json({
      installations,
      total: state.length,
      updates_available: response.success.entries.filter((entry) => entry.has_update).length,
    }),
  );
});
