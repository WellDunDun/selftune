import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildRemoteSnapshot,
  RemoteLibrary,
  type RemoteArtifact,
  type RemoteDiagnostics,
  type RemoteIntegrityFailure,
  type RemoteLibraryUnavailable,
  type RemoteLibraryError,
  type RemoteObjectMissing,
  type RemoteSnapshot,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LibraryError } from "../errors.js";

const BackupObject = Schema.Struct({ objectHash: Schema.String, contentBase64: Schema.String });
const RemoteLibraryBackup = Schema.Struct({
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  headSnapshotId: Schema.NullOr(Schema.String),
  snapshots: Schema.Array(Schema.Unknown),
  objects: Schema.Array(BackupObject),
});

export interface RemoteSyncObject {
  readonly artifact: RemoteArtifact;
  readonly bytes: Uint8Array;
}

export interface RemoteSyncEffectOptions<E = never, R = never> {
  readonly objects: ReadonlyArray<RemoteSyncObject>;
  readonly now?: Date;
  readonly onSnapshot?: (snapshot: RemoteSnapshot) => Effect.Effect<void, E, R>;
}

export interface RemoteSyncResult {
  readonly snapshot: RemoteSnapshot;
  readonly uploaded: number;
  readonly unchanged: number;
}

export interface RemoteExportEffectOptions {
  readonly outputPath: string;
  readonly now?: Date;
}

export interface RemoteExportResult {
  readonly outputPath: string;
  readonly snapshots: number;
  readonly objects: number;
}

function artifactIdentity(artifact: RemoteArtifact): {
  readonly artifactId: string;
  readonly artifactType: RemoteArtifact["artifactType"];
  readonly objectHash: string;
  readonly revisionHash: string | null;
} {
  return {
    artifactId: artifact.artifactId,
    artifactType: artifact.artifactType,
    objectHash: artifact.objectHash,
    revisionHash: artifact.revisionHash,
  };
}

function sameArtifacts(head: RemoteSnapshot, artifacts: ReadonlyArray<RemoteArtifact>): boolean {
  const current = head.artifacts
    .map(artifactIdentity)
    .toSorted((left, right) => left.artifactId.localeCompare(right.artifactId));
  return JSON.stringify(current) === JSON.stringify(artifacts.map(artifactIdentity));
}

function exportError(cause: unknown, outputPath: string): LibraryError {
  if (cause instanceof LibraryError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new LibraryError(
    `Could not export Remote Library to ${outputPath}: ${detail}`,
    "OPERATION_FAILED",
  );
}

const snapshotHistory = Effect.fn("selftune.library.remote.snapshotHistory")(function* () {
  const remote = yield* RemoteLibrary;
  const history: RemoteSnapshot[] = [];
  let current = yield* remote.head;
  while (current) {
    history.push(current);
    current = current.parentSnapshotId ? yield* remote.getSnapshot(current.parentSnapshotId) : null;
  }
  return history;
});

export const syncRemoteObjectsEffect = Effect.fn("selftune.library.remote.syncObjects")(function* <
  E = never,
  R = never,
>(options: RemoteSyncEffectOptions<E, R>) {
  const remote = yield* RemoteLibrary;
  const uploads = yield* Effect.forEach(
    options.objects,
    Effect.fn(function* (object) {
      if (yield* remote.hasObject(object.artifact.objectHash)) return false;
      yield* remote.putObject({
        objectHash: object.artifact.objectHash,
        bytes: object.bytes,
      });
      return true;
    }),
    { concurrency: "unbounded" },
  );
  const uploaded = uploads.reduce((total, didUpload) => total + (didUpload ? 1 : 0), 0);
  const unchanged = uploads.length - uploaded;

  const advanceSnapshot = Effect.fn("selftune.library.remote.advanceSnapshot")(function* () {
    const head = yield* remote.head;
    const merged = new Map<string, RemoteArtifact>();
    for (const artifact of head?.artifacts ?? []) merged.set(artifact.artifactId, artifact);
    for (const object of options.objects) {
      const artifact = object.artifact;
      const existing = merged.get(artifact.artifactId);
      if (existing && existing.objectHash !== artifact.objectHash) {
        return yield* Effect.fail(
          new LibraryError(
            `Sync & Backup conflict for ${artifact.artifactId}.`,
            "GUARD_BLOCKED",
            "Review both immutable revisions before choosing an active pointer.",
          ),
        );
      }
      merged.set(artifact.artifactId, artifact);
    }
    const artifacts = [...merged.values()].toSorted((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    );
    if (head && sameArtifacts(head, artifacts)) return head;

    const snapshot = buildRemoteSnapshot({
      parentSnapshotId: head?.snapshotId ?? null,
      createdAt: (options.now ?? new Date()).toISOString(),
      artifacts,
    });
    return yield* remote.commitSnapshot(snapshot);
  });

  const snapshot = yield* advanceSnapshot().pipe(
    Effect.retry({
      times: 2,
      while: (error) => "_tag" in error && error._tag === "RemoteConflict",
    }),
  );
  if (options.onSnapshot) yield* options.onSnapshot(snapshot);
  return { snapshot, uploaded, unchanged } satisfies RemoteSyncResult;
});

export const exportRemoteLibraryEffect = Effect.fn("selftune.library.remote.export")(function* (
  options: RemoteExportEffectOptions,
) {
  const remote = yield* RemoteLibrary;
  const snapshots = yield* snapshotHistory();
  const hashes = [
    ...new Set(
      snapshots.flatMap((snapshot) => snapshot.artifacts.map((artifact) => artifact.objectHash)),
    ),
  ].toSorted();
  const objects = yield* Effect.forEach(
    hashes,
    Effect.fn(function* (objectHash) {
      const bytes = yield* remote.getObject(objectHash);
      return { objectHash, contentBase64: Buffer.from(bytes).toString("base64") };
    }),
    { concurrency: "unbounded" },
  );
  const backup = RemoteLibraryBackup.make({
    version: 1,
    exportedAt: (options.now ?? new Date()).toISOString(),
    headSnapshotId: snapshots[0]?.snapshotId ?? null,
    snapshots,
    objects,
  });
  const outputPath = resolve(options.outputPath);
  yield* Effect.try({
    try: () => {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(backup, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    },
    catch: (cause) => exportError(cause, outputPath),
  });
  return {
    outputPath,
    snapshots: snapshots.length,
    objects: objects.length,
  } satisfies RemoteExportResult;
});

export const diagnoseRemoteEffect = Effect.fn("selftune.library.remote.diagnose")(function* () {
  return yield* (yield* RemoteLibrary).diagnostics;
});

export type RemoteSyncEffectError<E = never> = RemoteLibraryError | LibraryError | E;
export type RemoteExportEffectError =
  | RemoteIntegrityFailure
  | RemoteLibraryUnavailable
  | RemoteObjectMissing
  | LibraryError;
export type RemoteDiagnoseEffectError = RemoteLibraryUnavailable;
export type RemoteDiagnoseEffectResult = RemoteDiagnostics;
