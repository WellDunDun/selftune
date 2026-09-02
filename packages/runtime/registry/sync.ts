import { randomUUID } from "node:crypto";

import { Effect, Result } from "effect";

import { RegistryClient, RegistryHttpError, registryRequest } from "./client.js";
import { RegistrySyncResponse } from "./contracts.js";
import { validateRegistryVersion } from "./path-policy.js";
import { RegistryPlatform } from "./platform.js";
import { enqueueRegistryReceipt, flushRegistryOutbox } from "./registry-outbox.js";
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

function clearSuggestionState<
  T extends { automaticSuggestion?: unknown; lastSuggestion?: unknown; pendingUpdate?: unknown },
>(entry: T): Omit<T, "automaticSuggestion" | "lastSuggestion" | "pendingUpdate"> {
  const {
    automaticSuggestion: _automaticSuggestion,
    lastSuggestion: _lastSuggestion,
    pendingUpdate: _pendingUpdate,
    ...remaining
  } = entry;
  return remaining;
}

export const runRegistrySync = Effect.fn("selftune.registry.sync")(function* (
  options: {
    readonly automaticOnly?: boolean;
  } = {},
) {
  const platform = yield* RegistryPlatform;
  yield* flushRegistryOutbox().pipe(Effect.ignore);
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
  const updates = response.success.entries.filter(
    (entry) => entry.has_update && (!options.automaticOnly || entry.automatic_update_allowed),
  );
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
    if (!local) {
      failed++;
      continue;
    }
    const attempt = yield* Effect.gen(function* () {
      const previousVersionId = local.versionId ?? update.current_version_id ?? null;
      const target = yield* platform.validatePersistedTarget(local.installPath, local.name);
      const observedContentHash = yield* platform.computeInstalledContentHash(target.targetDir);
      const pendingUpdateMatches =
        local.pendingUpdate?.targetVersionHash === update.latest_content_hash &&
        local.pendingUpdate.targetVersion === update.latest_version;
      const recoveredAppliedUpdate =
        pendingUpdateMatches &&
        observedContentHash === local.pendingUpdate?.expectedInstalledContentHash;
      const hasLocalDrift =
        !local.localContentHash || observedContentHash !== local.localContentHash;
      const adoptedExactLocalSuggestion =
        recoveredAppliedUpdate ||
        (hasLocalDrift &&
          local.lastSuggestion?.observedContentHash === observedContentHash &&
          local.lastSuggestion.candidateContentHash === update.latest_content_hash);
      const protectedPaths = adoptedExactLocalSuggestion
        ? []
        : yield* platform.findProtectedPaths(target.targetDir);
      if (
        (hasLocalDrift && !adoptedExactLocalSuggestion) ||
        (local.pendingUpdate !== undefined && !pendingUpdateMatches) ||
        protectedPaths.length > 0
      ) {
        const receiptId = randomUUID();
        if (local.installationId) {
          yield* platform.withStateTransaction((latest) => {
            const current = latest.find((entry) => entry.entryId === local.entryId);
            if (!registryStateEntriesMatch(current, local) || !current) {
              return Effect.succeed(keepRegistryState(false));
            }
            return Effect.succeed(
              commitRegistryState(
                upsertRegistryStateEntry(
                  latest,
                  enqueueRegistryReceipt(current, {
                    installedVersion: local.version ?? update.current_version ?? "unknown",
                    installedContentHash: observedContentHash,
                    previousVersionId,
                    status: "conflict",
                    receiptId,
                  }),
                ),
                true,
              ),
            );
          });
          yield* flushRegistryOutbox().pipe(Effect.ignore);
        }
        const protectedDetail =
          protectedPaths.length > 0
            ? ` Protected local paths (${protectedPaths.slice(0, 3).join(", ")}) must be moved or backed up before a team rollout can replace this skill.`
            : "";
        return yield* Effect.fail(
          operationError(
            "sync",
            new Error(
              `Local changes detected in '${local.name}'. Automatic replacement was blocked while SelfTune prepares or waits for workspace review of those edits.${protectedDetail}`,
            ),
          ),
        );
      }
      const version = yield* validate("sync", () => validateRegistryVersion(update.latest_version));
      const receiptId = pendingUpdateMatches
        ? (local.pendingUpdate?.receiptId ?? randomUUID())
        : randomUUID();
      const committed = adoptedExactLocalSuggestion
        ? yield* platform.withStateTransaction((latest) => {
            const latestEntry = latest.find((entry) => entry.entryId === local.entryId);
            if (!registryStateEntriesMatch(latestEntry, local)) {
              return Effect.succeed(keepRegistryState(false));
            }
            return platform.computeInstalledContentHash(target.targetDir).pipe(
              Effect.flatMap((freshContentHash) => {
                if (freshContentHash !== observedContentHash) {
                  return Effect.succeed(keepRegistryState(false));
                }
                const reconciled = {
                  ...clearSuggestionState(local),
                  previousVersionHash: local.versionHash,
                  versionHash: update.latest_content_hash,
                  version,
                  versionId: update.latest_version_id ?? local.versionId,
                  localContentHash: freshContentHash,
                  receiptId,
                };
                return Effect.succeed(
                  commitRegistryState(
                    upsertRegistryStateEntry(
                      latest,
                      local.installationId
                        ? enqueueRegistryReceipt(reconciled, {
                            installedVersion: version,
                            installedContentHash: freshContentHash,
                            previousVersionId,
                            status: "updated",
                            receiptId,
                          })
                        : reconciled,
                    ),
                    true,
                  ),
                );
              }),
            );
          })
        : yield* Effect.gen(function* () {
            if (!update.download_url) {
              return yield* operationError(
                "sync",
                new Error(`Registry update '${update.name}' has no download URL`),
              );
            }
            const archive = yield* client.download(update.download_url);
            const expectedInstalledContentHash = yield* platform.computeArchiveContentHash({
              archive,
              expectedHash: update.latest_content_hash,
              label: `${update.name} v${version}`,
            });
            const marked = yield* platform.withStateTransaction((latest) => {
              const latestEntry = latest.find((entry) => entry.entryId === local.entryId);
              if (!registryStateEntriesMatch(latestEntry, local)) {
                return Effect.succeed(keepRegistryState(false));
              }
              return Effect.succeed(
                commitRegistryState(
                  upsertRegistryStateEntry(latest, {
                    ...local,
                    pendingUpdate: {
                      receiptId,
                      targetVersionHash: update.latest_content_hash,
                      targetVersion: version,
                      ...(update.latest_version_id
                        ? { targetVersionId: update.latest_version_id }
                        : {}),
                      ...(previousVersionId ? { previousVersionId } : {}),
                      observedContentHashBefore: observedContentHash,
                      expectedInstalledContentHash,
                    },
                  }),
                  true,
                ),
              );
            });
            if (!marked) return false;

            yield* platform.installArchive({
              archive,
              expectedHash: update.latest_content_hash,
              installRoot: target.installRoot,
              skillName: local.name,
              version,
              label: `${update.name} v${version}`,
            });
            const contentHash = yield* platform.computeInstalledContentHash(target.targetDir);
            if (contentHash !== expectedInstalledContentHash) {
              return yield* operationError(
                "sync",
                new Error(`Registry update '${update.name}' produced an unexpected file tree`),
              );
            }
            return yield* platform.withStateTransaction((latest) => {
              const latestEntry = latest.find((entry) => entry.entryId === local.entryId);
              if (latestEntry?.pendingUpdate?.receiptId !== receiptId) {
                return Effect.succeed(keepRegistryState(false));
              }
              const installed = {
                ...clearSuggestionState(latestEntry),
                previousVersionHash: local.versionHash,
                versionHash: update.latest_content_hash,
                version,
                versionId: update.latest_version_id ?? local.versionId,
                localContentHash: contentHash,
                receiptId,
              };
              return Effect.succeed(
                commitRegistryState(
                  upsertRegistryStateEntry(
                    latest,
                    local.installationId
                      ? enqueueRegistryReceipt(installed, {
                          installedVersion: version,
                          installedContentHash: contentHash,
                          previousVersionId,
                          status: "updated",
                          receiptId,
                        })
                      : installed,
                  ),
                  true,
                ),
              );
            });
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
      yield* flushRegistryOutbox().pipe(Effect.ignore);
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
