import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import {
  RemoteLibrary,
  sha256,
  type RemoteArtifact,
  type RemoteLibraryError,
  type RemoteSnapshot,
  type SyncPreferences,
} from "@selftune/control-plane";
import { importPortableSkillSet } from "@selftune/library";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { mergeSkillIntelligenceLearnedState } from "../skill-intelligence/learned-state.js";
import { CLIError } from "../utils/cli-error.js";
import { assertSafeRelativePath } from "./package-identity.js";
import { UnknownRecord } from "./package-bundle.js";

export type PullRemoteLibraryError = CLIError | RemoteLibraryError;

export interface PullRemoteLibraryStateEffectOptions {
  readonly configRoot: string;
  readonly snapshot: RemoteSnapshot;
  readonly preferences: SyncPreferences;
  readonly db?: Database;
}

function invalidSkillSetManifest(setId: string): CLIError {
  return new CLIError(
    `Downloaded Skill Set "${setId}" has an invalid manifest.`,
    "OPERATION_FAILED",
    "Do not use this Skill Set until the remote snapshot has been repaired.",
  );
}

function localPullFailure(operation: string, cause: unknown): CLIError {
  if (cause instanceof CLIError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CLIError(
    `Sync & Backup could not finish ${operation}: ${detail}`,
    "OPERATION_FAILED",
    "Review the local Library state and retry Sync & Backup.",
  );
}

function remotePullFailure(operation: string, cause: RemoteLibraryError): CLIError {
  switch (cause._tag) {
    case "RemoteLibraryUnavailable":
      if (/HTTP (?:401|403)\b/.test(cause.message)) {
        return new CLIError(
          `Sync & Backup credentials were rejected while ${operation}.`,
          "AUTH_MISSING",
          "Reconnect SelfTune Cloud or the self-hosted server, then apply the Skill Set again.",
        );
      }
      break;
    case "RemoteObjectMissing":
      return new CLIError(
        `A pinned skill revision is no longer available from Sync & Backup while ${operation}.`,
        "FILE_NOT_FOUND",
        "Sync the Skill Set again from a machine that still has the pinned revision.",
      );
    case "RemoteIntegrityFailure":
      return new CLIError(
        `Sync & Backup rejected a skill revision during ${operation} because it failed integrity checks.`,
        "OPERATION_FAILED",
        "Retry the sync from a trusted machine before applying this Skill Set.",
      );
    case "RemoteConflict":
      break;
  }
  return new CLIError(
    `Sync & Backup could not be reached while ${operation}.`,
    "API_ERROR",
    "Check the connection and credentials, then apply the Skill Set again.",
    1,
    true,
  );
}

const pullRemoteSkillSetManifestEffect = Effect.fn(
  "selftune.runtime.remoteLibrary.pullSkillSetManifest",
)(function* (options: {
  readonly configRoot: string;
  readonly setId: string;
  readonly artifact: RemoteArtifact;
}) {
  const localPath = join(options.configRoot, "skill-sets", `${options.setId}.json`);
  const exists = yield* Effect.try({
    try: () => existsSync(localPath),
    catch: (cause) => localPullFailure(`checking Skill Set "${options.setId}"`, cause),
  });
  if (exists) return false;

  const remote = yield* RemoteLibrary;
  const bytes = yield* remote
    .getObject(options.artifact.objectHash)
    .pipe(
      Effect.mapError((cause) =>
        remotePullFailure(`downloading Skill Set "${options.setId}"`, cause),
      ),
    );
  if (sha256(bytes) !== options.artifact.objectHash) {
    return yield* Effect.fail(
      new CLIError(
        `Downloaded Skill Set "${options.setId}" failed object verification.`,
        "OPERATION_FAILED",
        "Do not use this Skill Set until the remote copy has been repaired.",
      ),
    );
  }

  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
    catch: () => invalidSkillSetManifest(options.setId),
  });
  const decoded = yield* Schema.decodeUnknownEffect(UnknownRecord)(parsed).pipe(
    Effect.mapError(() => invalidSkillSetManifest(options.setId)),
  );
  if (decoded.set_id !== options.setId || decoded.revision_hash !== options.artifact.revisionHash) {
    return yield* Effect.fail(
      new CLIError(
        `Downloaded Skill Set "${options.setId}" does not match its remote identity.`,
        "OPERATION_FAILED",
        "Do not use this Skill Set until the remote snapshot has been repaired.",
      ),
    );
  }

  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        mkdirSync(options.configRoot, { recursive: true, mode: 0o700 });
        return join(options.configRoot, `.remote-skill-set-${randomUUID()}.json`);
      },
      catch: (cause) => localPullFailure(`staging Skill Set "${options.setId}"`, cause),
    }),
    (temporaryPath) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 }),
          catch: (cause) => localPullFailure(`staging Skill Set "${options.setId}"`, cause),
        });
        return yield* Effect.try({
          try: () => {
            const manifest = importPortableSkillSet(temporaryPath, {
              configRoot: options.configRoot,
              allowMissingDependencies: true,
              preserveExisting: true,
            });
            return (
              manifest.set_id === options.setId &&
              manifest.revision_hash === options.artifact.revisionHash
            );
          },
          catch: (cause) => localPullFailure(`importing Skill Set "${options.setId}"`, cause),
        });
      }),
    (temporaryPath) =>
      Effect.try({
        try: () => rmSync(temporaryPath, { force: true }),
        catch: (cause) => localPullFailure(`cleaning Skill Set "${options.setId}"`, cause),
      }),
  );
});

const pullRemoteSkillSetManifestsEffect = Effect.fn(
  "selftune.runtime.remoteLibrary.pullSkillSetManifests",
)(function* (options: { readonly configRoot: string; readonly snapshot: RemoteSnapshot }) {
  const newestBySet = new Map<string, RemoteArtifact>();
  for (const artifact of [...options.snapshot.artifacts]
    .filter((candidate) => candidate.artifactType === "skill_set")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const parts = artifact.artifactId.split("/");
    const setId = parts.length >= 3 ? (parts.at(-2) ?? "") : "";
    yield* Effect.try({
      try: () => assertSafeRelativePath(`${setId}.json`),
      catch: (cause) => localPullFailure("validating a remote Skill Set identity", cause),
    });
    if (!newestBySet.has(setId)) newestBySet.set(setId, artifact);
  }

  const results = yield* Effect.forEach(
    [...newestBySet],
    ([setId, artifact]) =>
      pullRemoteSkillSetManifestEffect({
        configRoot: options.configRoot,
        setId,
        artifact,
      }).pipe(Effect.result),
    { concurrency: "unbounded" },
  );
  const failure = results.find(Result.isFailure);
  if (failure) return yield* Effect.fail(failure.failure);
  return results.filter(Result.isSuccess).filter((result) => result.success).length;
});

const mergeLearnedStateEffect = Effect.fn("selftune.runtime.remoteLibrary.mergeLearnedState")(
  function* (db: Database, artifact: RemoteArtifact) {
    const remote = yield* RemoteLibrary;
    const bytes = yield* remote.getObject(artifact.objectHash);
    if (sha256(bytes) !== artifact.objectHash) {
      return yield* Effect.fail(
        new CLIError(
          `Remote learned state ${artifact.artifactId} failed object verification.`,
          "GUARD_BLOCKED",
        ),
      );
    }
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
      catch: (cause) => localPullFailure(`decoding learned state ${artifact.artifactId}`, cause),
    });
    yield* Effect.try({
      try: () => mergeSkillIntelligenceLearnedState(db, parsed),
      catch: (cause) => localPullFailure(`merging learned state ${artifact.artifactId}`, cause),
    });
  },
);

export const pullRemoteLibraryStateEffect = Effect.fn("selftune.runtime.remoteLibrary.pullState")(
  function* (options: PullRemoteLibraryStateEffectOptions) {
    if (options.preferences.skillSets) {
      yield* pullRemoteSkillSetManifestsEffect({
        configRoot: options.configRoot,
        snapshot: options.snapshot,
      });
    }
    if (!options.preferences.decisionHistory || !options.db) return;

    for (const artifact of options.snapshot.artifacts
      .filter((candidate) => candidate.artifactType === "learned_state")
      .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt))) {
      yield* mergeLearnedStateEffect(options.db, artifact);
    }
  },
);
