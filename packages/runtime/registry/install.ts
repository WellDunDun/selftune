import { randomUUID } from "node:crypto";

import { Effect, Result } from "effect";

import { RegistryClient, registryRequest } from "./client.js";
import {
  RegistryDetailResponse,
  RegistryInstallLookupResponse,
  RegistryInstallSyncResponse,
} from "./contracts.js";
import { parseGithubRegistryInstallTarget } from "./github-install.js";
import { validateRegistrySkillName, validateRegistryVersion } from "./path-policy.js";
import { RegistryPlatform } from "./platform.js";
import { flushRegistryOutbox } from "./registry-outbox.js";
import { validate } from "./program-support.js";
import {
  failure,
  json,
  operationError,
  registryFailure,
  success,
  type RegistryProgramInput,
  type RegistryProgramResult,
} from "./program-types.js";
import {
  commitRegistryState,
  keepRegistryState,
  registryStateEntriesMatch,
  upsertRegistryStateEntry,
} from "./registry-state-store.js";

function failureWithProgress(progress: string, message: string): RegistryProgramResult {
  return {
    operation: "install",
    stdout: [progress],
    stderr: [json({ error: message })],
    exitCode: 1,
  };
}

export const runRegistryInstall = Effect.fn("selftune.registry.install")(function* (
  input: Extract<RegistryProgramInput, { operation: "install" }>,
) {
  if (!input.target) {
    return failure("install", {
      error: "Usage: selftune registry install <name|github:owner/repo[@ref][//path]>",
      guidance: { next_command: "selftune registry list" },
    });
  }

  const parsedGithub = yield* Effect.try({
    try: () => parseGithubRegistryInstallTarget(input.target ?? ""),
    catch: (cause) => operationError("install", cause),
  }).pipe(Effect.result);
  if (Result.isFailure(parsedGithub)) {
    return failure("install", {
      error: parsedGithub.failure.message,
      guidance: { next_command: "selftune registry install github:owner/repo//path" },
    });
  }
  if (parsedGithub.success) {
    const platform = yield* RegistryPlatform;
    const installed = yield* platform
      .installFromGithub(input.target ?? "", input.global)
      .pipe(Effect.result);
    if (Result.isFailure(installed)) {
      return failure("install", {
        error: installed.failure.message,
        guidance: { next_command: "selftune registry install github:owner/repo//path" },
      });
    }
    return success("install", json(installed.success));
  }

  const platform = yield* RegistryPlatform;
  const preflightState = yield* platform.loadState();
  const lookup = yield* registryRequest(RegistryInstallLookupResponse, {
    method: "GET",
    path: `?name=${encodeURIComponent(input.target)}`,
  }).pipe(Effect.result);
  if (Result.isFailure(lookup) || lookup.success.entries.length === 0) {
    return failure("install", {
      error: `Skill '${input.target}' not found in registry`,
      guidance: { next_command: "selftune registry list" },
    });
  }
  const entry = lookup.success.entries[0];
  const skillName = yield* validate("install", () => validateRegistrySkillName(entry.name));
  const detail = yield* registryRequest(RegistryDetailResponse, {
    method: "GET",
    path: `/${encodeURIComponent(entry.id)}`,
  }).pipe(Effect.result);
  if (Result.isFailure(detail)) return registryFailure("install", detail.failure);
  const current = detail.success.versions.find((version) => version.is_current);
  if (!current) return failure("install", { error: "No current version found" });
  const version = yield* validate("install", () => validateRegistryVersion(current.version));

  const sync = yield* registryRequest(RegistryInstallSyncResponse, {
    method: "POST",
    path: "/sync",
    body: { installations: [{ entry_id: entry.id, current_version_hash: "none" }] },
  }).pipe(Effect.result);
  const downloadUrl = Result.isSuccess(sync) ? sync.success.entries[0]?.download_url : undefined;
  if (!downloadUrl) return failure("install", { error: "Could not get download URL" });

  const progress = `Installing ${skillName} v${version}...`;
  const target = yield* platform.resolveInstallTarget(skillName, input.global);
  const client = yield* RegistryClient;
  const archive = yield* client.download(downloadUrl).pipe(Effect.result);
  if (Result.isFailure(archive)) return failureWithProgress(progress, archive.failure.message);
  const expectedStateEntry = preflightState.find((item) => item.entryId === entry.id);
  const registrationReceiptId = randomUUID();
  const installed = yield* platform
    .withStateTransaction((latest) => {
      const latestEntry = latest.find((item) => item.entryId === entry.id);
      if (!registryStateEntriesMatch(latestEntry, expectedStateEntry)) {
        return Effect.succeed(keepRegistryState(false));
      }
      return platform
        .installArchive({
          archive: archive.success,
          expectedHash: current.content_hash,
          installRoot: target.installRoot,
          skillName,
          version,
          label: `${skillName} v${version}`,
        })
        .pipe(
          Effect.andThen(platform.computeInstalledContentHash(target.targetDir)),
          Effect.map((localContentHash) =>
            commitRegistryState(
              upsertRegistryStateEntry(latest, {
                entryId: entry.id,
                name: skillName,
                versionHash: current.content_hash,
                version,
                versionId: current.id,
                installPath: target.targetDir,
                localContentHash,
                receiptId: registrationReceiptId,
                pendingRegistration: {
                  receiptId: registrationReceiptId,
                  installPath: target.targetDir,
                  installedContentHash: localContentHash,
                },
              }),
              true,
            ),
          ),
        );
    })
    .pipe(Effect.result);
  if (Result.isFailure(installed)) return failureWithProgress(progress, installed.failure.message);
  if (!installed.success) {
    return failureWithProgress(
      progress,
      `Registry installation '${skillName}' changed while the archive was downloading; retry the install`,
    );
  }

  yield* flushRegistryOutbox().pipe(Effect.ignore);
  return success(
    "install",
    progress,
    json({ success: true, name: skillName, version, path: target.targetDir, global: input.global }),
  );
});
