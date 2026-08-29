import { Effect, Result, Schedule } from "effect";

import {
  RegistryAuthenticationError,
  RegistryConfigError,
  RegistryHttpError,
  registryRequest,
} from "./client.js";
import {
  RegistryContributionMutationResponse,
  RegistryContributionSnapshotResponse,
  RegistryDetailResponse,
} from "./contracts.js";
import { RegistryPlatform, type PreparedRegistryPush } from "./platform.js";
import { flushRegistryOutbox } from "./registry-outbox.js";
import { operationError, RegistryOperationError } from "./program-types.js";
import type { RegistryStateEntry } from "./registry-state.js";
import {
  commitRegistryState,
  keepRegistryState,
  registryStateEntriesMatch,
  upsertRegistryStateEntry,
} from "./registry-state-store.js";

const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const DEFAULT_STABLE_FOR_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60 * 1_000;
const DEFAULT_BLOCKED_RETRY_MS = 15 * 60 * 1_000;

export interface AutomaticRegistrySuggestionOptions {
  readonly now?: () => number;
  readonly scanIntervalMs?: number;
  readonly stableForMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly blockedRetryMs?: number;
}

export interface AutomaticRegistrySuggestionScanResult {
  readonly managed: number;
  readonly armed: number;
  readonly submitted: number;
  readonly deferred: number;
  readonly failed: number;
}

interface SubmittedSuggestion {
  readonly id: string;
  readonly status: "pending" | "rejected" | "adopted" | "stale" | "rolled_back";
}

function retryDelay(attempt: number, baseMs: number, maximumMs: number): number {
  return Math.min(maximumMs, baseMs * 2 ** Math.min(attempt, 10));
}

function candidateVersion(baseVersion: string | undefined, observedHash: string): string {
  const suffix = `.team.${observedHash.slice(0, 12)}`;
  const prefix = (baseVersion || "0.1.0").slice(0, Math.max(1, 50 - suffix.length));
  return `${prefix}${suffix}`;
}

function isTerminalFailure(cause: unknown): boolean {
  if (cause instanceof RegistryAuthenticationError || cause instanceof RegistryConfigError) {
    return true;
  }
  if (cause instanceof RegistryOperationError && cause.operation === "automatic-suggestion") {
    return true;
  }
  return (
    cause instanceof RegistryHttpError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 408 &&
    cause.status !== 425 &&
    cause.status !== 429
  );
}

function failureCode(cause: unknown): string {
  if (cause instanceof RegistryHttpError) return `http_${cause.status}`;
  if (cause instanceof RegistryAuthenticationError) return "authentication";
  if (cause instanceof RegistryConfigError) return "configuration";
  if (cause instanceof RegistryOperationError) return cause.operation.replaceAll("-", "_");
  return "transport";
}

function automaticSummary(name: string): string {
  return `Automatically captured teammate edits to ${name}`;
}

function clearPendingSuggestion(entry: RegistryStateEntry): RegistryStateEntry {
  const { automaticSuggestion: _automaticSuggestion, ...remaining } = entry;
  return remaining;
}

const submitPreparedSuggestion = Effect.fn("selftune.registry.automaticSuggestions.submit")(
  function* (entry: RegistryStateEntry, baseVersionId: string, prepared: PreparedRegistryPush) {
    const formData = new FormData();
    formData.append(
      "metadata",
      JSON.stringify({
        baseVersionId,
        candidateVersion: prepared.version,
        candidateContentHash: prepared.archiveHash,
        summary: automaticSummary(entry.name),
        files: prepared.manifest,
      }),
    );
    formData.append(
      "archive",
      new Blob([Uint8Array.from(prepared.archiveBuffer)], { type: "application/gzip" }),
      `${prepared.name}.tar.gz`,
    );

    const submission = yield* registryRequest(RegistryContributionMutationResponse, {
      method: "POST",
      path: `/api/v1/collaboration/registry/${encodeURIComponent(entry.entryId)}/contributions`,
      formData,
    }).pipe(Effect.result);
    if (Result.isSuccess(submission)) return submission.success satisfies SubmittedSuggestion;

    // The archive is deterministic. If the request committed but its response was lost, or a
    // previous process crashed before recording its receipt, reconcile the existing candidate
    // instead of producing another review item.
    const snapshot = yield* registryRequest(RegistryContributionSnapshotResponse, {
      method: "GET",
      path: "/api/v1/collaboration",
    }).pipe(Effect.result);
    if (Result.isSuccess(snapshot)) {
      const existing = snapshot.success.contributions.find(
        (candidate) =>
          candidate.entryId === entry.entryId &&
          candidate.baseVersionId === baseVersionId &&
          candidate.candidateContentHash === prepared.archiveHash &&
          candidate.status !== "rolled_back",
      );
      if (existing)
        return { id: existing.id, status: existing.status } satisfies SubmittedSuggestion;
    }
    return yield* submission.failure;
  },
);

const updateEntry = Effect.fn("selftune.registry.automaticSuggestions.updateState")(function* (
  expected: RegistryStateEntry,
  update: (current: RegistryStateEntry) => RegistryStateEntry,
) {
  const platform = yield* RegistryPlatform;
  yield* flushRegistryOutbox().pipe(Effect.ignore);
  return yield* platform.withStateTransaction((latest) => {
    const current = latest.find((entry) => entry.entryId === expected.entryId);
    if (!registryStateEntriesMatch(current, expected) || !current) {
      return Effect.succeed(keepRegistryState(false));
    }
    return Effect.succeed(
      commitRegistryState(upsertRegistryStateEntry(latest, update(current)), true),
    );
  });
});

const scanEntry = Effect.fn("selftune.registry.automaticSuggestions.scanEntry")(function* (
  entry: RegistryStateEntry,
  options: Required<Omit<AutomaticRegistrySuggestionOptions, "scanIntervalMs">>,
) {
  const platform = yield* RegistryPlatform;
  const target = yield* platform.validatePersistedTarget(entry.installPath, entry.name);
  const observedContentHash = yield* platform.computeInstalledContentHash(target.targetDir);

  // Old state predating content receipts remains untrusted. Only a fresh Registry install can
  // establish its exact clean baseline; relabeling current bytes would let rollout overwrite
  // unknown local edits later.
  if (!entry.localContentHash) {
    return "deferred";
  }

  if (observedContentHash === entry.localContentHash) {
    if (entry.automaticSuggestion) {
      yield* updateEntry(entry, clearPendingSuggestion);
    }
    return "unchanged";
  }
  if (entry.lastSuggestion?.observedContentHash === observedContentHash) return "unchanged";

  const now = options.now();
  const pending = entry.automaticSuggestion;
  if (
    !pending ||
    pending.observedContentHash !== observedContentHash ||
    pending.baseVersionHash !== entry.versionHash ||
    pending.baseVersionId !== entry.versionId
  ) {
    yield* updateEntry(entry, (current) => ({
      ...current,
      automaticSuggestion: {
        observedContentHash,
        baseVersionHash: current.versionHash,
        ...(current.versionId ? { baseVersionId: current.versionId } : {}),
        stableAt: now + options.stableForMs,
        attemptCount: 0,
        nextAttemptAt: now + options.stableForMs,
      },
    }));
    return "armed";
  }
  if (now < pending.stableAt || now < pending.nextAttemptAt) return "deferred";

  let baseVersionId = pending.baseVersionId;
  let baseVersion = entry.version;
  if (!baseVersionId) {
    const detail = yield* registryRequest(RegistryDetailResponse, {
      method: "GET",
      path: `/${encodeURIComponent(entry.entryId)}`,
    });
    const base = detail.versions.find(
      (version) => version.content_hash === pending.baseVersionHash,
    );
    if (!base) {
      return yield* operationError(
        "automatic-suggestion",
        new Error("The installed Registry base revision is unavailable"),
      );
    }
    baseVersionId = base.id;
    baseVersion = base.version;
  }

  const prepared = yield* platform.preparePackage(target.targetDir, {
    operation: "suggest",
    name: entry.name,
    version: candidateVersion(baseVersion, observedContentHash),
    summary: automaticSummary(entry.name),
  });
  if (!prepared) {
    return yield* operationError(
      "automatic-suggestion",
      new Error("The managed Registry skill no longer contains SKILL.md"),
    );
  }

  const afterPackagingHash = yield* platform.computeInstalledContentHash(target.targetDir);
  if (afterPackagingHash !== observedContentHash) {
    yield* updateEntry(entry, (current) => ({
      ...current,
      automaticSuggestion: {
        observedContentHash: afterPackagingHash,
        baseVersionHash: current.versionHash,
        ...(current.versionId ? { baseVersionId: current.versionId } : {}),
        stableAt: now + options.stableForMs,
        attemptCount: 0,
        nextAttemptAt: now + options.stableForMs,
      },
    }));
    return "armed";
  }

  const submitted = yield* submitPreparedSuggestion(entry, baseVersionId, prepared);
  const recorded = yield* updateEntry(entry, (current) => ({
    ...clearPendingSuggestion(current),
    lastSuggestion: {
      observedContentHash,
      candidateContentHash: prepared.archiveHash,
      baseVersionHash: pending.baseVersionHash,
      baseVersionId,
      contributionId: submitted.id,
      submittedAt: new Date(now).toISOString(),
    },
  }));
  return recorded ? "submitted" : "deferred";
});

export const runAutomaticRegistrySuggestionScan = Effect.fn(
  "selftune.registry.automaticSuggestions.scan",
)(function* (input: AutomaticRegistrySuggestionOptions = {}) {
  const platform = yield* RegistryPlatform;
  const options = {
    now: input.now ?? Date.now,
    stableForMs: input.stableForMs ?? DEFAULT_STABLE_FOR_MS,
    retryBaseMs: input.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    retryMaxMs: input.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    blockedRetryMs: input.blockedRetryMs ?? DEFAULT_BLOCKED_RETRY_MS,
  };
  const state = yield* platform.loadState();
  const result = {
    managed: state.length,
    armed: 0,
    submitted: 0,
    deferred: 0,
    failed: 0,
  } satisfies AutomaticRegistrySuggestionScanResult;

  for (const entry of state) {
    const outcome = yield* scanEntry(entry, options).pipe(Effect.result);
    if (Result.isSuccess(outcome)) {
      if (outcome.success === "armed") result.armed += 1;
      if (outcome.success === "submitted") result.submitted += 1;
      if (outcome.success === "deferred") result.deferred += 1;
      continue;
    }
    result.failed += 1;
    const pending = entry.automaticSuggestion;
    if (!pending) continue;
    const attemptCount = pending.attemptCount + 1;
    const blocked = isTerminalFailure(outcome.failure);
    const nextAttemptAt = blocked
      ? options.now() + options.blockedRetryMs
      : options.now() + retryDelay(attemptCount - 1, options.retryBaseMs, options.retryMaxMs);
    yield* updateEntry(entry, (current) => ({
      ...current,
      automaticSuggestion: {
        ...pending,
        attemptCount,
        nextAttemptAt,
        lastFailure: {
          kind: blocked ? "blocked" : "retrying",
          code: failureCode(outcome.failure),
          at: options.now(),
        },
      },
    })).pipe(Effect.ignore);
    if (blocked) {
      yield* Effect.logWarning(
        `Automatic team suggestion for '${entry.name}' paused until ${new Date(nextAttemptAt).toISOString()} (${failureCode(outcome.failure)}).`,
      );
    }
  }
  return result;
});

export const runAutomaticRegistrySuggestions = Effect.fn(
  "selftune.registry.automaticSuggestions.worker",
)(function* (options: AutomaticRegistrySuggestionOptions = {}) {
  const interval = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  const resilientScan = runAutomaticRegistrySuggestionScan(options).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        `Automatic team suggestion scan failed and will retry: ${cause.message}`,
      ).pipe(Effect.as({ managed: 0, armed: 0, submitted: 0, deferred: 0, failed: 1 })),
    ),
  );
  yield* resilientScan;
  return yield* Effect.repeat(resilientScan, Schedule.spaced(interval));
});
