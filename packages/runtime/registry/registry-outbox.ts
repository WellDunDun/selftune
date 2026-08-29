import { Effect, Result } from "effect";

import { registryRequest } from "./client.js";
import { EmptyRegistryResponse, RegistryInstallationMutationResponse } from "./contracts.js";
import { RegistryPlatform } from "./platform.js";
import type { RegistryStateEntry } from "./registry-state.js";
import {
  commitRegistryState,
  keepRegistryState,
  upsertRegistryStateEntry,
} from "./registry-state-store.js";

export type PendingRegistryReceipt = NonNullable<RegistryStateEntry["pendingReceipts"]>[number];

export function enqueueRegistryReceipt(
  entry: RegistryStateEntry,
  receipt: PendingRegistryReceipt,
): RegistryStateEntry {
  const existing = entry.pendingReceipts ?? [];
  const duplicate = existing.find(
    (candidate) =>
      candidate.status === receipt.status &&
      candidate.installedVersion === receipt.installedVersion &&
      candidate.installedContentHash === receipt.installedContentHash &&
      candidate.previousVersionId === receipt.previousVersionId,
  );
  if (duplicate) return entry;
  return { ...entry, pendingReceipts: [...existing, receipt] };
}

export const flushRegistryOutbox = Effect.fn("selftune.registry.outbox.flush")(function* () {
  const platform = yield* RegistryPlatform;
  const initial = yield* platform.loadState();

  for (const entry of initial) {
    const pending = entry.pendingRegistration;
    if (!pending || entry.installationId) continue;
    const recorded = yield* registryRequest(RegistryInstallationMutationResponse, {
      method: "POST",
      path: `/${encodeURIComponent(entry.entryId)}/install`,
      body: {
        install_path: pending.installPath,
        device_id: platform.deviceId,
        installed_content_hash: pending.installedContentHash,
        receipt_id: pending.receiptId,
      },
    }).pipe(Effect.result);
    if (Result.isFailure(recorded)) continue;
    yield* platform.withStateTransaction((latest) => {
      const current = latest.find((candidate) => candidate.entryId === entry.entryId);
      if (current?.pendingRegistration?.receiptId !== pending.receiptId) {
        return Effect.succeed(keepRegistryState(false));
      }
      const { pendingRegistration: _pendingRegistration, ...remaining } = current;
      return Effect.succeed(
        commitRegistryState(
          upsertRegistryStateEntry(latest, {
            ...remaining,
            installationId: recorded.success.data.id,
          }),
          true,
        ),
      );
    });
  }

  const registered = yield* platform.loadState();
  for (const entry of registered) {
    if (!entry.installationId) continue;
    for (const receipt of entry.pendingReceipts ?? []) {
      const sent = yield* registryRequest(EmptyRegistryResponse, {
        method: "POST",
        path: `/api/v1/collaboration/registry/${encodeURIComponent(entry.entryId)}/installations/${encodeURIComponent(entry.installationId)}/receipt`,
        body: receipt,
      }).pipe(Effect.result);
      if (Result.isFailure(sent)) continue;
      yield* platform.withStateTransaction((latest) => {
        const current = latest.find((candidate) => candidate.entryId === entry.entryId);
        if (
          !current?.pendingReceipts?.some((candidate) => candidate.receiptId === receipt.receiptId)
        ) {
          return Effect.succeed(keepRegistryState(false));
        }
        const remainingReceipts = current.pendingReceipts.filter(
          (candidate) => candidate.receiptId !== receipt.receiptId,
        );
        const updated =
          remainingReceipts.length === 0
            ? (({ pendingReceipts: _pendingReceipts, ...remaining }) => remaining)(current)
            : { ...current, pendingReceipts: remainingReceipts };
        return Effect.succeed(commitRegistryState(upsertRegistryStateEntry(latest, updated), true));
      });
    }
  }
});
