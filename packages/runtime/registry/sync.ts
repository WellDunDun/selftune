import { Effect, Result } from "effect";

import { RegistryClient, RegistryHttpError, registryRequest } from "./client.js";
import { RegistrySyncResponse } from "./contracts.js";
import { validateRegistryVersion } from "./path-policy.js";
import { RegistryPlatform } from "./platform.js";
import { validate } from "./program-support.js";
import {
  json,
  operationError,
  registryFailure,
  success,
  type RegistryProgramResult,
} from "./program-types.js";
import {
  commitRegistryState,
  keepRegistryState,
  registryStateEntriesMatch,
  upsertRegistryStateEntry,
} from "./registry-state-store.js";

export const runRegistrySync = Effect.fn("selftune.registry.sync")(function* () {
  const platform = yield* RegistryPlatform;
  const state = yield* platform.loadState();
  if (state.length === 0) {
    return success(
      "sync",
      json({
        message: "No registry installations found. Use 'selftune registry install <name>' first.",
      }),
    );
  }
  const response = yield* registryRequest(RegistrySyncResponse, {
    method: "POST",
    path: "/sync",
    body: {
      installations: state.map((entry) => ({
        entry_id: entry.entryId,
        current_version_hash: entry.versionHash,
      })),
    },
  }).pipe(Effect.result);
  if (Result.isFailure(response)) return registryFailure("sync", response.failure);
  const updates = response.success.entries.filter((entry) => entry.has_update);
  if (updates.length === 0) {
    return success("sync", json({ message: "All installations up to date", count: state.length }));
  }
  const client = yield* RegistryClient;
  const stdout: string[] = [`Found ${updates.length} update(s)...`];
  const stderr: string[] = [];
  let synced = 0;
  let failed = 0;
  for (const update of updates) {
    const local = state.find((entry) => entry.entryId === update.entry_id);
    if (!update.download_url || !local) {
      failed++;
      continue;
    }
    const downloadUrl = update.download_url;
    const attempt = yield* Effect.gen(function* () {
      const target = yield* platform.validatePersistedTarget(local.installPath, local.name);
      const version = yield* validate("sync", () => validateRegistryVersion(update.latest_version));
      const archive = yield* client.download(downloadUrl);
      const committed = yield* platform.withStateTransaction((latest) => {
        const latestEntry = latest.find((entry) => entry.entryId === local.entryId);
        if (!registryStateEntriesMatch(latestEntry, local)) {
          return Effect.succeed(keepRegistryState(false));
        }
        return platform
          .installArchive({
            archive,
            expectedHash: update.latest_content_hash,
            installRoot: target.installRoot,
            skillName: local.name,
            version,
            label: `${update.name} v${version}`,
          })
          .pipe(
            Effect.as(
              commitRegistryState(
                upsertRegistryStateEntry(latest, {
                  ...local,
                  versionHash: update.latest_content_hash,
                }),
                true,
              ),
            ),
          );
      });
      if (!committed) {
        return yield* Effect.fail(
          operationError(
            "sync",
            new Error(
              `Registry installation '${local.name}' changed while its update was downloading; retry sync`,
            ),
          ),
        );
      }
      return version;
    }).pipe(Effect.result);
    if (Result.isFailure(attempt)) {
      failed++;
      if (!(attempt.failure instanceof RegistryHttpError)) {
        stderr.push(json({ error: attempt.failure.message, entry_id: update.entry_id }));
      }
    } else {
      synced++;
      stdout.push(`  updated: ${update.name} -> v${attempt.success}`);
    }
  }
  stdout.push(json({ synced, failed, total: state.length }));
  return { operation: "sync", stdout, stderr, exitCode: 0 } satisfies RegistryProgramResult;
});
