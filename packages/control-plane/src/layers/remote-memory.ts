import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  RemoteCapabilities,
  RemoteConflict,
  RemoteDiagnostics,
  RemoteIntegrityFailure,
  RemoteObjectMissing,
  type RemoteSnapshot,
} from "../domain";
import { sha256 } from "../programs/remote-library";
import { RemoteLibrary } from "../services";

interface MemoryState {
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly snapshots: ReadonlyMap<string, RemoteSnapshot>;
  readonly headId: string | null;
}

const initialState: MemoryState = {
  objects: new Map(),
  snapshots: new Map(),
  headId: null,
};

export const RemoteLibraryMemory = Layer.effect(
  RemoteLibrary,
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState);

    return RemoteLibrary.of({
      capabilities: Effect.succeed(
        RemoteCapabilities.make({
          protocolVersion: 1,
          immutableObjects: true,
          compareAndSwapSnapshots: true,
          maxObjectBytes: 100 * 1024 * 1024,
        }),
      ),
      putObject: Effect.fn("RemoteLibraryMemory.putObject")(function* ({ objectHash, bytes }) {
        const actualHash = sha256(bytes);
        if (actualHash !== objectHash) {
          return yield* new RemoteIntegrityFailure({ expectedHash: objectHash, actualHash });
        }
        yield* Ref.update(state, (current) => {
          const objects = new Map(current.objects);
          objects.set(objectHash, Uint8Array.from(bytes));
          return { ...current, objects };
        });
      }),
      hasObject: (objectHash) =>
        Ref.get(state).pipe(Effect.map((current) => current.objects.has(objectHash))),
      getObject: Effect.fn("RemoteLibraryMemory.getObject")(function* (objectHash) {
        const current = yield* Ref.get(state);
        const bytes = current.objects.get(objectHash);
        if (!bytes) return yield* new RemoteObjectMissing({ objectHash });
        return Uint8Array.from(bytes);
      }),
      head: Ref.get(state).pipe(
        Effect.map((current) =>
          current.headId === null ? null : (current.snapshots.get(current.headId) ?? null),
        ),
      ),
      getSnapshot: Effect.fn("RemoteLibraryMemory.getSnapshot")(function* (snapshotId) {
        const current = yield* Ref.get(state);
        const snapshot = current.snapshots.get(snapshotId);
        if (!snapshot) return yield* new RemoteObjectMissing({ objectHash: snapshotId });
        return snapshot;
      }),
      commitSnapshot: Effect.fn("RemoteLibraryMemory.commitSnapshot")(function* (snapshot) {
        const current = yield* Ref.get(state);
        if (snapshot.parentSnapshotId !== current.headId) {
          return yield* new RemoteConflict({
            expectedParentId: snapshot.parentSnapshotId,
            actualParentId: current.headId,
          });
        }
        for (const artifact of snapshot.artifacts) {
          if (!current.objects.has(artifact.objectHash)) {
            return yield* new RemoteObjectMissing({ objectHash: artifact.objectHash });
          }
        }
        const snapshots = new Map(current.snapshots);
        snapshots.set(snapshot.snapshotId, snapshot);
        yield* Ref.set(state, { ...current, snapshots, headId: snapshot.snapshotId });
        return snapshot;
      }),
      diagnostics: Ref.get(state).pipe(
        Effect.map((current) => {
          const referenced = new Set(
            [...current.snapshots.values()].flatMap((snapshot) =>
              snapshot.artifacts.map((artifact) => artifact.objectHash),
            ),
          );
          const objectHashes = [...current.objects.keys()].sort();
          const missingObjects = [...referenced]
            .filter((hash) => !current.objects.has(hash))
            .sort();
          const orphanedObjects = objectHashes.filter((hash) => !referenced.has(hash));
          return RemoteDiagnostics.make({
            objectCount: current.objects.size,
            snapshotCount: current.snapshots.size,
            totalBytes: [...current.objects.values()].reduce(
              (total, bytes) => total + bytes.length,
              0,
            ),
            missingObjects,
            orphanedObjects,
          });
        }),
      ),
    });
  }),
);
